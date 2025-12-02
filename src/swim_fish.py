import pygame
from fish import Fish
from generacion_de_tuberias import tuberias
from screamer import Scream
import random
from game import Game
from ml.policy import crear_politica
from ml.calcular_estado import calcular_estado
from ml.vector_w import random_vector


class SwimFish(Game):
    def __init__(self, x, y, size, image):
        super().__init__()

        self.clock = pygame.time.Clock()
        self.running = True
        self.running_game = False
        self.game_over = False
        self.juego_iniciado = False

        self.fish = Fish(x, y, size, image)
        self.puntuacion = 0

        self.letra_grande = pygame.font.Font(None, 80)
        self.letra_pequena = pygame.font.Font(None, 36)
        self.letra_puntuacion = pygame.font.Font(None, 64)

        self.color_sombra = (0, 0, 0)
        self.offset_sombra = 2.5
        self.jumpscare = Scream()

        self.mostrar_jumpscare = False
        self.tiempo_jumpscare = 0
        self.enable_jumpscare = True

        if not hasattr(self, "lista_tuberias"):
            self.lista_tuberias = []

    def _calcular_estado_completo(self):
        fish_rect = self.fish.get_rect()

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

        vy = self.fish.velocity
        return dy, dx, vy

    def _dibujar_game_over(self):
        pygame.mixer.music.stop()
        centro_x = self.screen_w // 2
        centro_y = self.screen_h // 2

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
        pygame.mixer.music.stop()
        pygame.mixer.music.play(-1)

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
                    dy, dx, vy = self._calcular_estado_completo()
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