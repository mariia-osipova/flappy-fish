# Protected Flappy Fish score store

`Code.gs` is the storage gateway for the existing Node server. Browsers never
call it directly. Node verifies deterministic replay segments; Apps Script
authenticates Node, serializes state changes and stores the accepted state.

The spreadsheet is private. Keep every old unauthenticated writer disabled.
Publishing this code in Git does **not** update or retire an existing Apps Script
deployment.

## Staging setup

1. Make a staging copy of the spreadsheet, including its original `Scores`
   tab if legacy records are being imported. Back up the original before rollout.
2. Put this file in one Apps Script project. All writers must use that project:
   a lock from a different script project does not protect this store.
3. Set these **Script Properties** in Project Settings:

   | Property | Value |
   | --- | --- |
   | `SPREADSHEET_ID` | ID of the private target spreadsheet |
   | `GATEWAY_HMAC_KEY` | Same secret as Node; at least 32 characters, generated from at least 32 random bytes |
   | `MAX_RANKED_GAMES` | `5` initially; optional, defaults to 5; integer from 1 to 30 |

   Generate a fresh gateway secret with `openssl rand -hex 32`. Do not reuse the
   Node session or checkpoint signing key. Never put secrets in client JavaScript
   or commit them.
4. Run `initializeStorage()` manually in the Apps Script editor and authorize
   access. This creates `Games` and `Legacy` if absent. It does not modify
   `Scores` or overwrite an unfamiliar schema.
5. If importing history, stop the old writers, then manually run
   `migrateLegacyScores()`. Inspect its returned/logged report.
6. Deploy as a web app, executing as its owner, accessible to anyone. The public
   URL still requires the gateway HMAC for every operation; the spreadsheet
   itself must not be publicly editable or publicly readable.
7. Configure server-only `APPS_SCRIPT_URL` and `GATEWAY_HMAC_KEY` in the Node
   environment / AI Studio Secrets. Leave `RANKED_ENABLED=false` until staging
   tests, migration checks and retirement of **all** old public writers succeed.
8. On production rollout, update or archive every old deployment that accepts
   unauthenticated `doPost` or `doGet?action=save`. Merely changing the URL in
   the frontend leaves those writers usable.

Protect the service tabs from manual edits. Do not sort their rows, insert
formulas, change headers or run another writer. Use a separate reporting view
for human analysis. The runtime uses native `SpreadsheetApp`; enabling the
Advanced Sheets service is not necessary.

## Gateway protocol

The only HTTP operations are signed POST envelopes:

```json
{
  "version": 1,
  "action": "checkpoint",
  "requestId": "stable-operation-id",
  "timestamp": 1787918400000,
  "content": "{\"ownerId\":\"...\",\"gameId\":\"...\"}",
  "signature": "64-character-HMAC-SHA256-hex"
}
```

The UTF-8 HMAC message is exactly:

```text
flappy-fish-gateway-v1
<action>
<requestId>
<timestamp>
<content>
```

There is no trailing newline. `content` is the exact JSON string in the
envelope, not a parsed and reserialized object. Timestamps are Unix milliseconds
within 60 seconds of Apps Script's clock. Retries use a fresh transport timestamp
and signature but preserve the operation ID, operation hash and checkpoint.

Authentication and envelope checks happen before any spreadsheet access.
`doGet` always rejects the request without reading or writing the spreadsheet.
There is no JSONP, public save operation or HTTP migration action.

Responses are `{ok:true,data}` or
`{ok:false,error:{code,message,status,details?}}`. Apps Script ContentService
does not provide the Node API's HTTP status contract: Node must inspect `ok`
and map `error.status`, not treat an HTTP 200 from Google as a successful write.

| Action | Content |
| --- | --- |
| `begin` | `ownerId, name, rankKey, gameId, seed, rulesVersion, snapshot, stateHash, requestHash` |
| `read` | `ownerId, gameId` |
| `checkpoint` | `ownerId, gameId, prevSeq, prevStateHash, leaseEpoch, snapshot, stateHash, inputTicks, pause, requestHash` |
| `resume` | `ownerId, gameId, prevSeq, prevStateHash, leaseEpoch, requestHash` |
| `scores` | Optional `name`; optional server-only `includeIndex:true` |

Game actions return the complete canonical game record. Hashes are lowercase
SHA-256 hex supplied by the authenticated Node gateway. Node recomputes hashes
and performs the replay; Apps Script does not accept a browser-provided score.
`begin.requestHash` excludes random server proposals, so a retry on another
Node instance can recover the original seed and game ID.

## State, capacity and recovery

Each game occupies one JSON cell in `Games`, including its latest bounded
snapshot, request receipt, lease and final result. No checkpoint appends another
attempt. JSON storage also keeps names beginning with `=` as text.

- Default capacity is **five** active, unexpired games globally and one per
  anonymous owner. Extra players can train. Malformed capacity configuration
  fails closed; raising the limit requires new staging measurements.
- A lease lasts **120 seconds**. Checkpoints contain at most **1200 ticks**
  at 120 ticks/second; snapshot JSON is bounded to **4096 UTF-8 bytes**.
  Only a new checkpoint advancing ticks extends the lease.
- Pausing may use zero ticks and releases the place. Resuming requires capacity,
  increments `leaseEpoch` and compares the prior sequence/hash/epoch.
  Expiry also requires resume before further checkpoints; it never silently
  starts a new game or grants extra points.
- The server-clock pacing check retains previously accumulated active time,
  caps an expired interval at its old lease end, and excludes paused time and
  time after lease expiry. There is no overall active-game duration limit.
- New games are additionally limited to six per owner per minute, derived from
  stored game rows. Node's request/replay limits are a separate protection.
- All mutations take `ScriptLock`, update the authoritative JSON cell and call
  `SpreadsheetApp.flush()` before releasing the lock. Reads do not initialize
  sheets, migrate headers, extend leases or modify the store.
- Repeating the last ID, hash and action returns the saved record **before**
  lease, sequence or completed-state checks. A changed hash conflicts. Older
  checkpoints are rejected by sequence/hash/epoch and require `read` recovery.
  Begin IDs are retained separately for recovery after later checkpoints.
- If a write committed but its reply was lost, retrying does not append a
  duplicate or renew the lease. Node must issue a new signed browser checkpoint
  only after this gateway confirms the saved record.
- `snapshot.dead === true` completes the game and stores `finalScore` in the
  same cell as the terminal status. Active, paused and expired unfinished games
  never appear in the leaderboard.

This is serialized, idempotent application storage, not a database transaction
or a promise of exactly-once network delivery. Unknown write outcomes are retried
with the original ID; store failures never fall back to trusting client scores.
Google documents the requirement to
[flush pending spreadsheet changes before releasing the lock](https://developers.google.com/apps-script/reference/lock/lock).

## Legacy migration and leaderboard

`migrateLegacyScores()` supports the old `Name / Best Score / Updated At`
schema and the newer `Name / Score / Best Score / Updated At` schema.
It reads `Scores` without changing cells or headers and rebuilds only `Legacy`.
Repeating the migration with unchanged source data produces unchanged legacy
records. Stale target rows are cleared in the same range replacement.

Names use the existing game normalization: trim, collapse whitespace, take the
first 24 UTF-16 code units, then lowercase for the ranking key. There is no NFKC
normalization and **no ownership protection for nicknames**. Multiple anonymous
sessions using the same normalized nickname deliberately share a leaderboard
entry.

Only finite, nonnegative safe-integer scores are imported. Invalid rows are
reported with their source row numbers and remain untouched in `Scores`.
Invalid timestamps are reported separately; their valid scores are retained
with a null timestamp. A successful import is not proof that an old score was
earned honestly.

The leaderboard takes the maximum of legacy and completed verified results per
normalized name. A verified result wins an equal-score tie. A higher legacy
score remains marked `source:"legacy", verified:false`.

`scores` returns `{scores, player, updatedAt}`: top 100 results plus an exact
name match even outside the top 100. Rows have
`name, bestScore, source, verified, updatedAt, rank`.
For Node's 30-second aggregate cache, `includeIndex:true` additionally returns
all best-per-name summaries as `index`, never game snapshots or owner IDs.
Node must remove this internal index from public responses. More than 100,000
unique names fails closed instead of silently truncating exact-name lookup.

## Tests and rollout limits

Run the offline fake-SpreadsheetApp tests from the project root:

```sh
node --test tests/apps-script-store.test.js
```

The shared VM harness in `tests/helpers/apps-script-harness.js` runs the real
`Code.gs`, supports a deterministic clock, seeds legacy sheets, and injects
failures before/after writes or during flush. It does not contact Google.

Staging must exercise five simultaneous rated games, representative accumulated
history, many training users, retries, pause/resume and loss of a response after
commit. Measure Google latency, busy-lock responses and quota errors before
enabling production ranking. Hundreds of training players do not imply hundreds
of simultaneous rated games. Per-instance Node caching is an optimization,
never authoritative storage.

HMAC prevents unauthorized mutations, but a known public Apps Script URL can
still receive requests that consume execution resources. There are
[Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas);
the owner must monitor them. The global lock and history scans are intentional
limits of this small Sheets-only deployment.

Sanitized runtime logs report successful begin/resume occupancy and classify
storage failures as busy, quota, configuration, corrupt record or backend.
They do not include player names, owner/game IDs, replay content, signatures,
secrets or raw exception text.
