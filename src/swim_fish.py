import pygame
from fish import Fish
from generacion_de_tuberias import tuberias
from screamer import Scream
import random
from game import Game
from ml.policy import crear_politica
from ml.calcular_estado import calcular_estado
from ml.vector_w import random_vector
import time
import math


class SwimFish(Game):
    def __init__(self, x, y, size, image):
        super().__init__()

        self.clock = pygame.time.Clock()
        self.running = True
        self.running_game = False
        self.game_over = False
        self.juego_iniciado = False

        self.fish_image_path = image
        self.fondo_dead_fish = pygame.image.load("data/img/dead-fish.png").convert_alpha()
        self.fish_size = size

        self.fish = Fish(x, y, size, image)
        self.puntuacion = 0

        font_path = "data/font/StrangeFont-Regular.otf"
        self.letra_grande = pygame.font.Font(font_path, 80)
        self.letra_pequena = pygame.font.Font(font_path, 36)
        self.letra_puntuacion = pygame.font.Font(font_path, 64)
        self.letra_panel = pygame.font.Font(font_path, 26)

        self.color_sombra = (0, 0, 0)
        self.offset_sombra = 2.5
        self.jumpscare = Scream()

        self.mostrar_jumpscare = False
        self.tiempo_jumpscare = 0
        self.enable_jumpscare = True

        death_path = "data/img/death.png"
        self.death_image = pygame.image.load(death_path).convert_alpha()
        self.death_image.set_alpha(120)

        self.generacion = 1

        self.genome_names = []
        self.genome_avg = []
        self.genome_std = []

        self.fitness_history = []
        self.fitness_history_max_len = 30

        self.ghosts = []

        if not hasattr(self, "lista_tuberias"):
            self.lista_tuberias = []

    def _calcular_estado_completo(self, fish):
        fish_rect = fish.get_rect()

        proxima_tuberia = None
        for t in self.lista_tuberias:
            if t.tubo_arriba.right >= fish_rect.left:
                proxima_tuberia = t
                break

        if proxima_tuberia is not None:
            dy, dx = calcular_estado(fish_rect, proxima_tuberia)
        else:
            dy = fish_rect.centery - (self.screen_h // 2)
            dx = 200.0

        vy = fish.velocity
        return dy, dx, vy

    def _dibujar_game_over(self):
        pygame.mixer.music.stop()
        centro_x = self.screen_w // 2
        centro_y = self.screen_h // 2

        self.screen.blit(self.fondo_dead_fish, (0, 0))

        texto_perdiste_sombra = self.letra_grande.render(
            '- FIN DEL JUEGO -', True, self.color_sombra
        )
        rect_perdiste_sombra = texto_perdiste_sombra.get_rect(
            center=(centro_x + self.offset_sombra, centro_y - 70 + self.offset_sombra)
        )
        self.screen.blit(texto_perdiste_sombra, rect_perdiste_sombra)

        texto_perdiste = self.letra_grande.render(
            '- FIN DEL JUEGO -', True, (255, 0, 0)
        )
        rect_perdiste = texto_perdiste.get_rect(center=(centro_x, centro_y - 70))
        self.screen.blit(texto_perdiste, rect_perdiste)

        texto_puntuacion_final_sombra = self.letra_pequena.render(
            f'Puntuación total: {self.puntuacion}',
            True,
            self.color_sombra,
        )
        rect_puntuacion_final_sombra = texto_puntuacion_final_sombra.get_rect(
            center=(centro_x + self.offset_sombra, centro_y + 10 + self.offset_sombra)
        )
        self.screen.blit(texto_puntuacion_final_sombra, rect_puntuacion_final_sombra)

        texto_puntuacion_final = self.letra_pequena.render(
            f'Puntuación total: {self.puntuacion}',
            True,
            (255, 255, 255),
        )
        rect_puntuacion_final = texto_puntuacion_final.get_rect(
            center=(centro_x, centro_y + 10)
        )
        self.screen.blit(texto_puntuacion_final, rect_puntuacion_final)

        texto_reiniciar_sombra = self.letra_pequena.render(
            '¡Presiona R para Reiniciar o M para volver al Menú!',
            True,
            self.color_sombra,
        )
        rect_reiniciar_sombra = texto_reiniciar_sombra.get_rect(
            center=(centro_x + self.offset_sombra, centro_y + 50 + self.offset_sombra)
        )
        self.screen.blit(texto_reiniciar_sombra, rect_reiniciar_sombra)

        texto_reiniciar = self.letra_pequena.render(
            '¡Presiona R para Reiniciar o M para volver al Menú!',
            True,
            (255, 255, 255),
        )
        rect_reiniciar = texto_reiniciar.get_rect(center=(centro_x, centro_y + 50))
        self.screen.blit(texto_reiniciar, rect_reiniciar)

    def reiniciar_juego(self):
        self.mostrar_jumpscare = False
        self.tiempo_jumpscare = 0
        self.game_over = False
        self.juego_iniciado = False
        self.puntuacion = 0
        self.lista_tuberias = []
        self.fish.reset()
        #pygame.mixer.music.stop()
        #pygame.mixer.music.play(-1)

    def _dibujar_puntuacion(self):
        puntuacion_str = str(self.puntuacion)
        texto_sombra = self.letra_puntuacion.render(puntuacion_str, True, (0, 0, 0))
        texto_puntuacion = self.letra_puntuacion.render(
            puntuacion_str, True, (255, 255, 255)
        )
        x_base, y_base = 20, 20
        offset = 3
        self.screen.blit(texto_sombra, (x_base + offset, y_base + offset))
        self.screen.blit(texto_puntuacion, (x_base, y_base))

    def swim(self, auto: bool = False, pesos=None):
        self.running_game = True

        self.enable_jumpscare = not auto

        decidir = None
        if auto:
            if pesos is None:
                pesos = random_vector()
            decidir, pesos_usados = crear_politica(pesos)
            self.pesos_actuales = pesos_usados
            self.juego_iniciado = True
            pygame.mixer.music.play(-1)
        else:
            self.game_over = False
            self.juego_iniciado = False

        while self.running_game:
            delta_time = self.clock.tick(self.FPS) / 1000.0
            self.frame_timer += delta_time
            if self.frame_timer >= 1.0 / self.frame_rate:
                self.frame_index = (self.frame_index + 1) % len(self.background_frames)
                self.frame_timer = 0

            if auto and self.game_over:
                self.reiniciar_juego()
                self.juego_iniciado = True

            if self.enable_jumpscare:
                self.jumpscare.actualizar_jumpscare()

            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    self.running = False
                    self.running_game = False
                    return 'QUIT'

                if self.game_over:
                    if (not auto) and event.type == pygame.KEYDOWN:
                        if event.key == pygame.K_r:
                            self.reiniciar_juego()
                        elif event.key == pygame.K_m:
                            self.running_game = False
                            return 'MENU'
                    continue

                if event.type == self.evento_nueva_tuberia and self.juego_iniciado:
                    nueva_tuberia = tuberias(
                        self.screen_w, self.hueco_entre_tuberias, self.imagen_tuberia
                    )
                    self.lista_tuberias.append(nueva_tuberia)

                if (not auto) and event.type == pygame.KEYDOWN:
                    if event.key == pygame.K_SPACE:
                        if not self.juego_iniciado:
                            self.juego_iniciado = True
                            pygame.mixer.music.play(-1)
                        self.fish.flap()
                        self.sonido_salto.play()
                    elif event.key == pygame.K_RIGHT:
                        self.fish.right()
                    elif event.key == pygame.K_LEFT:
                        self.fish.left()

            if not self.game_over and self.juego_iniciado:
                if auto and decidir is not None:
                    dy, dx, vy = self._calcular_estado_completo(self.fish)
                    if decidir(dy, dx, vy):
                        self.fish.flap()
                        self.sonido_salto.play()

                self.fish.update()

                for t in self.lista_tuberias:
                    t.mover_tuberias()
                self.lista_tuberias = [
                    t
                    for t in self.lista_tuberias
                    if t.x > -self.imagen_tuberia.get_width()
                ]

                fish_rect = self.fish.get_rect()

                if fish_rect.top <= 0 or fish_rect.bottom >= self.screen_h:
                    self.game_over = True

                for tuberia in self.lista_tuberias:
                    if tuberia.x < fish_rect.left and not tuberia.pasada:
                        self.puntuacion += 1
                        tuberia.pasada = True

                    for tuberia_rect in tuberia.get_rects():
                        tuberia_mask = pygame.mask.from_surface(self.imagen_tuberia)
                        offset_x = tuberia_rect.left - self.fish.rect.left
                        offset_y = tuberia_rect.top - self.fish.rect.top

                        if self.fish.mask.overlap(tuberia_mask, (offset_x, offset_y)):
                            self.game_over = True
                            if self.enable_jumpscare:
                                i = random.randint(0, 10)
                                if i <= 4:
                                    self.jumpscare.asustar()
                            break

            current_frame = self.background_frames[self.frame_index]
            self.screen.blit(current_frame, (0, 0))
            self.screen.blit(self.fondo_marino, (0, 0))

            for tuberia in self.lista_tuberias:
                tuberia.dibujar_tuberias(self.screen)

            self.fish.draw(self.screen)

            if not self.game_over:
                if self.juego_iniciado:
                    self._dibujar_puntuacion()
                else:
                    if not auto:
                        texto_inicio_sombra = self.letra_pequena.render(
                            '¡Presiona ESPACIO para comenzar!',
                            True,
                            self.color_sombra,
                        )
                        rect_inicio_sombra = texto_inicio_sombra.get_rect(
                            center=(
                                self.screen_w // 2 + self.offset_sombra,
                                self.screen_h // 2 + self.offset_sombra,
                            )
                        )
                        self.screen.blit(texto_inicio_sombra, rect_inicio_sombra)

                        texto_inicio = self.letra_pequena.render(
                            '¡Presiona ESPACIO para comenzar!',
                            True,
                            (255, 255, 255),
                        )
                        rect_inicio = texto_inicio.get_rect(
                            center=(self.screen_w // 2, self.screen_h // 2)
                        )
                        self.screen.blit(texto_inicio, rect_inicio)
            else:
                if not auto:
                    self._dibujar_game_over()

            if self.enable_jumpscare:
                self.jumpscare.dibujar_jumpscare()

            pygame.display.flip()

        return 'MENU'

    def _actualizar_estadisticas_genoma(self, pesos_lista):
        if not pesos_lista:
            self.genome_avg = []
            self.genome_std = []
            return

        n = len(pesos_lista)
        m = len(pesos_lista[0])

        promedios = []
        desvios = []

        for j in range(m):
            vals = [w[j] for w in pesos_lista]
            mean = sum(vals) / n
            var = sum((v - mean) ** 2 for v in vals) / n
            std = math.sqrt(var)
            promedios.append(mean)
            desvios.append(std)

        self.genome_avg = promedios
        self.genome_std = desvios

        if not self.genome_names or len(self.genome_names) != m:
            self.genome_names = [f"w{j}" for j in range(m)]

    def _actualizar_fitness_hist(self, value):
        self.fitness_history.append(float(value))
        if len(self.fitness_history) > self.fitness_history_max_len:
            self.fitness_history.pop(0)

    def _dibujar_panel_info(self, dx, dy, vy, generacion, tuberias, vivos):
        panel_width = 340
        panel_rect = pygame.Rect(self.screen_w - panel_width, 0, panel_width, self.screen_h)

        panel_surface = pygame.Surface((panel_rect.width, panel_rect.height), pygame.SRCALPHA)
        panel_surface.fill((0, 0, 0, 220))

        x = 20
        y = 20
        dy_line = 26

        titulo = self.letra_panel.render("GA Statistics", True, (255, 255, 0))
        panel_surface.blit(titulo, (x, y))
        y += dy_line * 2

        texto_gen = self.letra_panel.render(f"Generation: {generacion}", True, (255, 255, 255))
        panel_surface.blit(texto_gen, (x, y))
        y += dy_line

        texto_dx = self.letra_panel.render(f"Dx= {dx:.1f}", True, (255, 255, 255))
        panel_surface.blit(texto_dx, (x, y))
        y += dy_line

        texto_dy = self.letra_panel.render(f"Dy= {dy:.1f}", True, (255, 255, 255))
        panel_surface.blit(texto_dy, (x, y))
        y += dy_line

        texto_v = self.letra_panel.render(f"Velocity: {vy: .4f}", True, (255, 255, 255))
        panel_surface.blit(texto_v, (x, y))
        y += dy_line

        alive_count = len(vivos)

        texto_tot = self.letra_panel.render(f"Alive = {alive_count}/100", True, (255, 255, 255))
        panel_surface.blit(texto_tot, (x, y))
        y += dy_line

        texto_tub = self.letra_panel.render(f"Tubes= {tuberias}", True, (255, 255, 255))
        panel_surface.blit(texto_tub, (x, y))
        y += dy_line * 2

        titulo_gen = self.letra_panel.render("Genome (Avg ± Std)", True, (200, 200, 200))
        panel_surface.blit(titulo_gen, (x, y))
        y += dy_line + 10

        bar_left = x + 55
        bar_width = panel_rect.width - bar_left - 80
        bar_height = 10
        line_gap = 22

        if self.genome_avg:
            max_abs = max(abs(a) + s for a, s in zip(self.genome_avg, self.genome_std))
            if max_abs == 0:
                max_abs = 1.0
        else:
            max_abs = 1.0

        for name, avg, std in zip(self.genome_names, self.genome_avg, self.genome_std):
            label = self.letra_panel.render(name + ":", True, (200, 200, 200))
            panel_surface.blit(label, (x, y - 4))

            bar_rect = pygame.Rect(bar_left, y, bar_width, bar_height)
            pygame.draw.rect(panel_surface, (60, 60, 60), bar_rect)

            zero_x = bar_left + bar_width // 2

            if std > 0:
                ext = min((abs(std) / max_abs) * (bar_width / 2), bar_width / 2)
                std_rect = pygame.Rect(zero_x - ext, y, 2 * ext, bar_height)
                pygame.draw.rect(panel_surface, (90, 90, 90), std_rect)

            if avg >= 0:
                w = min((avg / max_abs) * (bar_width / 2), bar_width / 2)
                val_rect = pygame.Rect(zero_x, y, w, bar_height)
                color = (0, 180, 0)
            else:
                w = min((abs(avg) / max_abs) * (bar_width / 2), bar_width / 2)
                val_rect = pygame.Rect(zero_x - w, y, w, bar_height)
                color = (200, 60, 60)

            pygame.draw.rect(panel_surface, color, val_rect)
            pygame.draw.rect(panel_surface, (120, 120, 120), bar_rect, 1)

            txt_val = self.letra_panel.render(f"{avg:.3f}", True, (200, 200, 200))
            panel_surface.blit(txt_val, (bar_left + bar_width + 14, y - 6))

            y += line_gap

        graph_height = 70
        graph_margin_bottom = 10
        graph_rect = pygame.Rect(
            15,
            panel_rect.height - graph_height - graph_margin_bottom,
            panel_rect.width - 30,
            graph_height,
        )

        pygame.draw.rect(panel_surface, (40, 40, 40), graph_rect)
        pygame.draw.rect(panel_surface, (255, 255, 255), graph_rect, 2)

        label = self.letra_panel.render(
            f"Fitness Progress ({self.fitness_history_max_len} gens)", True, (220, 220, 220)
        )
        panel_surface.blit(label, (graph_rect.x + 4, graph_rect.y + 4))

        if len(self.fitness_history) >= 2:
            values = self.fitness_history
            v_min = min(values)
            v_max = max(values)
            if v_max == v_min:
                v_max = v_min + 1.0

            pts = []
            for i, v in enumerate(values):
                t = i / (len(values) - 1)
                x_p = graph_rect.x + 4 + t * (graph_rect.width - 8)
                norm = (v - v_min) / (v_max - v_min)
                y_p = graph_rect.y + graph_rect.height - 4 - norm * (graph_rect.height - 20)
                pts.append((x_p, y_p))

            pygame.draw.lines(panel_surface, (255, 215, 0), False, pts, 2)

        self.screen.blit(panel_surface, panel_rect.topleft)

    def swim_population(self, pesos_poblacion, tiempo_max=120, umbral_distancia=30):
        self.running_game = True
        self.enable_jumpscare = False

        self.lista_tuberias = []
        self.puntuacion = 0
        self.game_over = False
        self.juego_iniciado = True

        self.ghosts = []

        agentes = []
        for pesos in pesos_poblacion:
            fish = Fish(150, 300, self.fish_size, self.fish_image_path)
            decidir, pesos_usados = crear_politica(pesos)
            agente = {
                "fish": fish,
                "pesos": pesos_usados,
                "decidir": decidir,
                "alive": True,
                "score": 0,
                "time_alive": 0.0,
                "passed": set(),
            }
            agentes.append(agente)

        inicio_epoca = time.time()

        while self.running_game:
            if time.time() - inicio_epoca > tiempo_max:
                break

            delta_time = self.clock.tick(self.FPS) / 1000.0
            self.frame_timer += delta_time
            if self.frame_timer >= 1.0 / self.frame_rate:
                self.frame_index = (self.frame_index + 1) % len(self.background_frames)
                self.frame_timer = 0

            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    self.running = False
                    self.running_game = False
                    return None, None, 'QUIT'

                if event.type == self.evento_nueva_tuberia and self.juego_iniciado:
                    nueva_tuberia = tuberias(
                        self.screen_w, self.hueco_entre_tuberias, self.imagen_tuberia
                    )
                    self.lista_tuberias.append(nueva_tuberia)

                if event.type == pygame.KEYDOWN:
                    if event.key == pygame.K_m:
                        self.running_game = False
                        return None, None, 'MENU'

            vivos = [a for a in agentes if a["alive"]]
            if len(vivos) == 0:
                break

            for t in self.lista_tuberias:
                t.mover_tuberias()
            self.lista_tuberias = [
                t
                for t in self.lista_tuberias
                if t.x > -self.imagen_tuberia.get_width()
            ]

            for agente in agentes:
                if not agente["alive"]:
                    continue

                agente["time_alive"] += delta_time

                fish = agente["fish"]
                decidir = agente["decidir"]

                dy, dx, vy = self._calcular_estado_completo(fish)
                if decidir(dy, dx, vy):
                    fish.flap()

                fish.update()

                fish_rect = fish.get_rect()
                if fish_rect.top <= 0 or fish_rect.bottom >= self.screen_h:
                    agente["alive"] = False
                    self.ghosts.append(fish_rect.center)
                    continue

                for tuberia in self.lista_tuberias:
                    if tuberia.x < fish_rect.left and id(tuberia) not in agente["passed"]:
                        agente["score"] += 1
                        agente["passed"].add(id(tuberia))

                    for tuberia_rect in tuberia.get_rects():
                        tuberia_mask = pygame.mask.from_surface(self.imagen_tuberia)
                        offset_x = tuberia_rect.left - fish_rect.left
                        offset_y = tuberia_rect.top - fish_rect.top
                        if fish.mask.overlap(tuberia_mask, (offset_x, offset_y)):
                            agente["alive"] = False
                            self.ghosts.append(fish_rect.center)
                            break

            mejor_score = max(a["score"] for a in agentes)
            self.puntuacion = mejor_score

            fitnesses = [
                a["score"] * 1000.0 + a["time_alive"]
                for a in agentes
            ]

            self._actualizar_estadisticas_genoma([a["pesos"] for a in agentes])
            # self._actualizar_fitness_hist(mejor_score)

            if mejor_score >= umbral_distancia:
                break

            current_frame = self.background_frames[self.frame_index]
            self.screen.blit(current_frame, (0, 0))
            self.screen.blit(self.fondo_marino, (0, 0))

            for tuberia in self.lista_tuberias:
                tuberia.dibujar_tuberias(self.screen)

            for agente in agentes:
                if agente["alive"]:
                    agente["fish"].draw(self.screen)

            if len(self.ghosts) > 500:
                self.ghosts = self.ghosts[-500:]

            for cx, cy in self.ghosts:
                ghost_rect = self.death_image.get_rect(center=(cx, cy))
                self.screen.blit(self.death_image, ghost_rect)

            self._dibujar_puntuacion()

            dx = dy = vy = 0.0
            if vivos:
                dy, dx, vy = self._calcular_estado_completo(vivos[0]["fish"])

            self._dibujar_panel_info(dx, dy, vy, self.generacion, self.puntuacion, vivos)

            if self.enable_jumpscare:
                self.jumpscare.dibujar_jumpscare()

            pygame.display.flip()

        pesos_finales = [a["pesos"] for a in agentes]
        return pesos_finales, fitnesses, 'OK'