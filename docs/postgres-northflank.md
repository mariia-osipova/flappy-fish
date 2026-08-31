# PostgreSQL и Northflank: развёртывание и перенос

Этот runbook описывает локальную PostgreSQL 16, CI, staging, первый production
cutover с Google Sheets и откат. До последнего шага в каждом окружении оставляйте
`RANKED_ENABLED=false`: это безопасное значение по умолчанию, при котором
practice-режим продолжает работать.

Документация Northflank и названия возможностей ниже проверены 31 августа 2026:

- [PostgreSQL addon и безопасный локальный доступ](https://northflank.com/docs/v1/application/databases-and-persistence/deploy-databases-on-northflank/deploy-postgresql-on-northflank);
- [подключение addon secrets к workload и aliases](https://northflank.com/docs/v1/application/databases-and-persistence/connect-database-secrets-to-workloads);
- [combined service из Git-репозитория и Dockerfile](https://northflank.com/docs/v1/application/getting-started/build-and-deploy-your-code);
- [liveness, readiness и startup probes](https://northflank.com/docs/v1/application/observe/configure-health-checks);
- [отдельные migration jobs и workflow порядка backup → migrate → deploy](https://northflank.com/docs/v1/application/release/run-migrations).

## Локальная PostgreSQL 16

Нужны Docker, Node.js 22 и Bun 1.4.0. Пароль ниже предназначен только для
контейнера разработчика; порт БД привязан к loopback и не доступен из локальной
сети.

```sh
docker compose -f compose.postgres.yml up -d --wait
export DATABASE_URL='postgresql://flappy_fish:flappy_fish_test@127.0.0.1:54329/flappy_fish_test'
export TEST_DATABASE_URL="$DATABASE_URL"
export DATABASE_APP_ROLE='flappy_fish'
bun install --frozen-lockfile
npm run db:migrate
npm test
npm run test:postgres
npm run build
```

Остановить контейнер:

```sh
docker compose -f compose.postgres.yml down
```

Добавьте `-v` только если намеренно хотите удалить локальные данные контейнера.
Не используйте локальные реквизиты из compose в staging или production.

Импорт CSV всегда начинается с dry-run. Оба файла обязательны, а CSV нельзя
добавлять в Git или Docker image:

```sh
node scripts/import-sheets-export.js \
  --games /secure/path/Games.csv \
  --legacy /secure/path/Legacy.csv \
  --dry-run

IMPORT_CONFIRM=POSTGRES_CUTOVER \
node scripts/import-sheets-export.js \
  --games /secure/path/Games.csv \
  --legacy /secure/path/Legacy.csv \
  --apply

node scripts/verify-postgres-import.js
```

`--dry-run` используется и без явного флага. `--apply` дополнительно требует
`IMPORT_CONFIRM=POSTGRES_CUTOVER`. Импорт не перезаписывает отличающиеся строки:
конфликт `game_id` или `rank_key` откатывает транзакцию целиком. После проверки
удалите рабочие CSV из локального диска в соответствии с политикой хранения.

## CI и Docker image

`.github/workflows/ci.yml` поднимает настоящий PostgreSQL 16 service container,
устанавливает зависимости строго по `bun.lock`, применяет миграции, выполняет
`npm test`, `npm run test:postgres`, `npm run build` и собирает Docker image.
Существующий `.github/workflows/pages.yml` остаётся отдельным: публикация
practice-сайта GitHub Pages не зависит от PostgreSQL workflow.

Dockerfile использует Bun 1.4.0 только в build/dependency stages и Node.js 22 в
runtime. Финальный слой получает только production dependencies; Playwright и
скачанные браузеры в него не копируются. Контейнер запускается пользователем
`node`, слушает `0.0.0.0:3000` и по умолчанию имеет
`RANKED_ENABLED=false`. В image нет `.env`, CSV-экспортов, тестов и документации.

Проверить image локально:

```sh
docker build -t flappy-fish:local .
docker run --rm -p 3000:3000 flappy-fish:local
```

Без runtime-секретов сервер остаётся practice-only. Не передавайте секреты через
`docker build --build-arg`, Dockerfile или committed `.env`; задавайте их только
как runtime variables Northflank.

## Ресурсы Northflank

Создайте staging и production в раздельных Northflank projects либо как минимум
с раздельными addon, secret groups, доменами и ключами. Production-экспорт
никогда не импортируйте в общедоступный preview.

### PostgreSQL addon

1. Создайте PostgreSQL addon версии **16** в том же project и регионе, что и
   сервис.
2. Не включайте public access. Для ручной диагностики используйте команду
   forwarding из раздела Local access Northflank CLI.
3. Настройте регулярные backups и сделайте отдельный backup непосредственно до
   миграции/импорта и после проверенного импорта.
4. Runtime должен использовать обычную строку подключения. Строку подключения
   администратора, имя которой в Northflank оканчивается `_ADMIN`, разрешите
   только migration/import job.

Migration job создаёт объекты от admin-роли, поэтому обязательно передайте ему обычное имя
пользователя addon через `DATABASE_APP_ROLE`. Миграция проверяет безопасный
формат идентификатора и выдаёт runtime-роли только `USAGE` схемы,
`SELECT/INSERT/UPDATE` для `games` и `SELECT` для `legacy_scores`. PostgreSQL не
выдаёт эти права другой роли автоматически; `/api/health/ready` не заменяет
DML-проверку.

### Secret groups и aliases

Используйте две разные secret groups и область применения «specific
services/jobs». Одинаковый alias безопасен только потому, что группы никогда не
подключаются к одному workload.

| Secret group | Linked addon value | Alias | Получатель |
| --- | --- | --- | --- |
| `flappy-fish-runtime` | обычный `POSTGRES_URI` | `DATABASE_URL` | только web service |
| `flappy-fish-migration` | connection URI с суффиксом `_ADMIN` | `DATABASE_URL` | только migration/import job |
| `flappy-fish-migration` | обычный `USERNAME` | `DATABASE_APP_ROLE` | только migration job |

К web service не подключайте admin secret group. К build stage не подключайте ни
одну группу: сборке не нужна БД, а addon не нужно делать публичным ради build.

В **staging** runtime group задайте следующие переменные. Значения с многоточием
вводятся в Northflank и никогда не записываются в репозиторий. В отдельной
production group обязательно замените `APP_ENV=staging` на
`APP_ENV=production`; остальные значения также задаются независимо, кроме
сохраняемых при cutover production HMAC-ключей.

```env
STORAGE_BACKEND=postgres
APP_ENV=staging
RANKED_ENABLED=false

DATABASE_URL=...
SESSION_HMAC_KEY=...
STATE_HMAC_KEY=...

MAX_RANKED_GAMES=5
DB_POOL_MAX=4
DB_CONNECTION_TIMEOUT_MS=5000
DB_STATEMENT_TIMEOUT_MS=5000

VERIFIER_WORKERS=1
VERIFIER_QUEUE=10

HOST=0.0.0.0
PORT=3000
```

`SESSION_HMAC_KEY` и `STATE_HMAC_KEY` должны быть разными случайными значениями
как минимум по 32 байта. Для staging используйте отдельные ключи. В production
при cutover сохраните текущие production-ключи, иначе существующие cookie и
checkpoint tokens станут недействительны. `GATEWAY_HMAC_KEY` PostgreSQL runtime
не нужен. Не выводите значения переменных, connection URI или export rows в
build/job/application logs.

### Combined web service

Создайте combined service со следующими начальными параметрами:

| Настройка | Значение |
| --- | --- |
| Source | GitHub-репозиторий Flappy Fish |
| Branch | staging-ветка, после проверки — `main` |
| Build type | Dockerfile из корня репозитория |
| Instances | **1** |
| Port | public HTTP, container port `3000` |
| Runtime secrets | только `flappy-fish-runtime` |
| Continuous delivery | выключено до ручной миграции и проверки |

Внешний трафик Northflank завершает по HTTPS; приложение внутри контейнера
слушает HTTP. Перед production cutover привяжите постоянный пользовательский
домен. Host-only cookie `__Host-flappy_session` не переносится между разными
Northflank-generated domains.

Начинайте с одной instance. Admission в PostgreSQL защищён транзакциями, но
HTTP rate limiter, verifier queue и leaderboard cache пока находятся в памяти
процесса. При двух экземплярах эти лимиты и кэш становятся отдельными. Перед
горизонтальным масштабированием вынесите глобальные лимиты в PostgreSQL/Redis и
повторите нагрузочный тест.

У combined service CI и CD включены по умолчанию. Перед push релиза, которому
нужна новая схема, **выключите CD**: CI может собрать commit, но не должен
автоматически развернуть его до backup и успешного migration job. После миграции
вручную разверните build того же commit. Не включайте постоянный auto-CD, пока
каждый schema-bearing release не имеет безопасного порядка операций.

### Manual migration job

Создайте отдельный job, не меняя команду старта web service:

| Настройка | Значение |
| --- | --- |
| Name | `flappy-fish-migrate` |
| Trigger | manual |
| Build | тот же commit/image, который будет развёрнут |
| Command | `npm run db:migrate` |
| Runtime secrets | только `flappy-fish-migration` |

Preflight команды `npm run db:migrate` требует и admin `DATABASE_URL`, и
`DATABASE_APP_ROLE`; при пропущенном или некорректном alias job завершается до
подключения к БД. Миграция `002_runtime_grants` также исправляет базу, где
начальная схема была создана до настройки отдельной runtime-роли.

Не запускайте `npm run db:migrate && npm start` в web container: несколько
реплик не должны соревноваться за применение схемы. Первый cutover выполняйте
ручным job после backup. Для дальнейшей автоматизации замените combined service
на отдельные build и deployment services, управляемые Northflank workflow
`backup → migration job → deploy`. Combined service является самодостаточным
CI/CD и не следует считать его deployment автоматически защищённым этим
workflow. Deployment должен выполняться только при успешном job.
`npm run db:migrate:down` предназначен для разработки, а не является обычным
production rollback. Не выдавайте web runtime право менять `legacy_scores` и
не задавайте blanket default write privileges на будущие таблицы. Каждая
следующая миграция должна явно выдавать новой таблице только нужные приложению
операции. После каждой миграции проверяйте owner и grants. До deployment
выполните через обычный
`DATABASE_URL` транзакционный smoke test таблицы `games`
`SELECT → INSERT → UPDATE → ROLLBACK` и отдельный `SELECT` из `legacy_scores`;
одного `SELECT 1` недостаточно.

Для импорта создайте отдельный ручной административный job из того же image либо
используйте защищённый Northflank CLI session. Передавайте пути CSV как secret
files/одноразовые защищённые файлы, не в image. Ограничьте job одной попыткой и
сначала выполните dry-run; для apply требуется `IMPORT_CONFIRM`.

### Health probes

Настройте две HTTP probes на port 3000:

| Probe | Path | Начальная настройка |
| --- | --- | --- |
| Liveness | `/api/health/live` | delay 10s, interval 30s, timeout 3s, max failures 3 |
| Readiness | `/api/health/ready` | delay 5s, interval 10s, timeout 3s, max failures 3 |

Liveness не обращается к БД: отказ PostgreSQL не должен создавать бесконечный
restart loop. Readiness при включённом рейтинге проверяет PostgreSQL и ожидаемую
схему; при ошибке возвращает 503 и Northflank убирает instance из load balancer.
При `RANKED_ENABLED=false` practice-only service может быть ready без БД, поэтому
положительная probe до включения рейтинга не доказывает, что migration/import
успешны. Проверяйте их отдельными командами.

## Staging

1. Создайте отдельный PostgreSQL 16 addon и backup schedule.
2. Подключите две staging secret groups; оставьте
   `APP_ENV=staging`, `RANKED_ENABLED=false`.
3. Выключите CD combined service, затем соберите staging commit; пока не
   разворачивайте schema-dependent build.
4. Сделайте backup пустой БД и вручную запустите `flappy-fish-migrate`.
5. Проверьте job logs без вывода connection URI или строк данных и только после
   успеха вручную разверните build того же commit в одном web instance.
6. Проверьте `/api/health/live` и `/api/health/ready`, затем права обычной
   runtime-роли на чтение и запись.
7. Импортируйте только тестовую копию CSV: dry-run, apply, verify. Сделайте
   второй backup.
8. Только на staging временно установите `RANKED_ENABLED=true` и пройдите
   `start → checkpoint → pause → resume → death → leaderboard`.
9. Перезапустите service и восстановите незавершённую партию.
10. Отправьте две конкурирующие ветки checkpoint: успешной должна стать одна.
11. Займите пять мест, убедитесь, что шестая игра получает штатный отказ, а один
    owner не получает две активные партии.
12. Выполните нагрузочный сценарий:

```sh
LOAD_TARGET_URL=https://STAGING_DOMAIN \
LOAD_CONFIRM=STAGING_ONLY \
npm run test:load
```

Критерии: p95 подтверждения checkpoint не выше 5 секунд, нет ошибок штатных
запросов, повреждения или потери партий. Зафиксируйте CPU/RAM, pool saturation,
количество DB connections, verifier queue, HTTP 429/503 и latency. После теста
верните `RANKED_ENABLED=false` до production cutover.

## Production cutover

Цель cutover — ровно один writer. Dual-write и автоматическое «догоняющее»
копирование между Sheets и PostgreSQL запрещены.

### 1. Подготовка без записи

1. Создайте production PostgreSQL addon, secret groups и migration job.
   Выключите CD combined service и соберите production commit, но пока не
   разворачивайте schema-dependent image. Сохраните текущие `SESSION_HMAC_KEY`,
   `STATE_HMAC_KEY` и пользовательский домен. Оставьте
   `RANKED_ENABLED=false` и явно задайте `APP_ENV=production`; production group
   не должна наследовать staging `APP_ENV` или staging database URL.
2. Сделайте backup PostgreSQL, запустите migration job для того же commit и
   проверьте схему/права. Только после успеха вручную разверните один web
   instance из соответствующего build.
3. Проверьте `/`, assets, `/api/health/live`, `/api/health/ready` и чтение
   `/api/scores`. Не считайте practice-only readiness доказательством работы БД.

### 2. Freeze старого writer и экспорт

1. На старом Node deployment установите `RANKED_ENABLED=false` и убедитесь, что
   новые `begin`, `checkpoint` и `resume` больше не принимаются.
2. Выполните `migrateLegacyScores()` в административном Apps Script.
3. Закройте **все** прежние writer deployments: резервные `/exec`, старые
   `doPost`, `doGet?action=save`, другие script projects и прямые права записи.
4. Снимите отдельный backup исходной таблицы и экспортируйте `Games.csv` и
   `Legacy.csv`. Зафиксируйте время freeze, количество строк и checksum списка
   game IDs. После экспорта не открывайте старый writer снова.

### 3. Импорт и проверка

1. Сделайте новый pre-import backup PostgreSQL.
2. Запустите importer с `--dry-run`; разберите каждую invalid row и warning.
3. Запустите `--apply` только с `IMPORT_CONFIRM=POSTGRES_CUTOVER`.
4. Выполните `node scripts/verify-postgres-import.js` и сравните:
   количество Games/completed/Legacy, active/paused, top 100, несколько точных
   ников, максимальный результат и checksum game IDs.
5. Сделайте post-import backup PostgreSQL и сохраните отчёты отдельно от
   пользовательских CSV.

### 4. Трафик и включение writer

1. Переключите постоянный production domain на Northflank, всё ещё с
   `RANKED_ENABLED=false`.
2. Проверьте cookie по HTTPS, `/`, assets, обе probes и `/api/scores`. Убедитесь,
   что старые публичные Apps Script writer endpoints недоступны.
3. Установите `RANKED_ENABLED=true` только после всех сравнений.
4. Проведите одну контрольную рейтинговую игру, включая checkpoint и завершение,
   и убедитесь, что verified result появился в leaderboard.
5. Наблюдайте error rate, DB connections и checkpoint latency особенно внимательно
   в первое окно эксплуатации. Не удаляйте исходный backup по итогам одной игры.

## Rollback

### До первого PostgreSQL write

Пока `RANKED_ENABLED=false` и в PostgreSQL нет новых production-записей, можно
вернуть домен на старый Node + защищённый Apps Script. Сначала подтвердите, что
старое хранилище не изменилось после export. Не возвращайте какой-либо старый
незащищённый writer.

### После первого PostgreSQL write

PostgreSQL уже является единственным source of truth. Нельзя просто выставить
`STORAGE_BACKEND=apps-script`: это создаст две расходящиеся истории.

1. Немедленно установите `RANKED_ENABLED=false`; practice остаётся доступен.
2. Сохраните PostgreSQL backup и диагностические логи без чувствительных полей.
3. Откатите application image только на предыдущую версию, совместимую с текущей
   PostgreSQL schema, либо выпустите forward-fix.
4. Не запускайте `db:migrate:down` автоматически. Восстановление pre-migration
   backup допустимо только с явным решением о судьбе всех более новых записей.
5. Возобновите writer после проверки migration, readiness, replay и leaderboard.
6. Возврат к Apps Script возможен лишь как отдельная обратная миграция с новым
   freeze/import/verify планом, не как переключение переменной.

## Наблюдение и риски

- Один web instance сохраняет глобальность in-memory rate limits, queue и cache,
  но является ограничением доступности и пропускной способности. Не включайте
  autoscaling без изменения этих механизмов и повторного load test.
- `DB_POOL_MAX=4` и `VERIFIER_WORKERS=1` — консервативный старт. Изменяйте их по
  измерениям CPU, latency, DB connections и очереди, а не только по числу HTTP
  запросов.
- При `RANKED_ENABLED=false` readiness намеренно допускает practice-only работу;
  пропущенная миграция проявится лишь при отдельной проверке или включении
  рейтинга.
- Ошибочное `APP_ENV=staging` в production ослабляет защиту load generator от
  случайного запуска на боевом сервисе. Проверяйте `APP_ENV=production` до
  привязки домена и никогда не наследуйте staging secret group.
- Admin URL в web service увеличивает последствия компрометации. Разделение
  secret groups и прав runtime-роли обязательно.
- Ротация HMAC-ключей лишает доступа к существующим session/checkpoint tokens;
  смена домена также теряет host-only cookie.
- CSV содержит пользовательские ники и внутренние игровые записи. Не храните его
  в Git, Docker layer, общем object storage или job logs.
- Миграции и код нужно выпускать в согласованном порядке. Ошибка после destructive
  migration требует backup/restore решения; автоматический down не является
  безопасным универсальным откатом.
- Следите за `storage_unavailable`, `conflict`, `ranked_full`, HTTP 429/503,
  checkpoint latency, restarts и failed probes. Логи не должны содержать
  `DATABASE_URL`, cookie, token, nickname, owner/game ID, snapshot или CSV rows.
