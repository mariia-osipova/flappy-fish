import pygame
from fish import Fish
from generacion_de_tuberias import tuberias
from game import Game
from ml.policy import crear_politica
from ml.calcular_estado import calcular_estado
from ml.vector_w import random_vector


class SwimFish(Game):
    def __init__(self, x, y, size, image):
        super().__init__()

        #self.screen = self.screen
        #self.FPS = self.FPS
        #self.evento_nueva_tuberia = self.evento_nueva_tuberia
        #self.hueco_entre_tuberias = self.hueco_entre_tuberias
        #self.imagen_tuberia = self.imagen_tuberia
        #self.lista_tuberias = self.lista_tuberias

        self.clock = pygame.time.Clock()
        self.running = True
        self.game_over = False
        self.fish = Fish(x, y, size, image)

        self.puntuacion = 0

        self.letra_grande = pygame.font.Font(None, 80)
        self.letra_pequena = pygame.font.Font(None, 36)
        self.letra_puntuacion = pygame.font.Font(None, 64)

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
        texto_perdiste = self.letra_grande.render('- FIN DEL JUEGO -', True, (255, 0, 0))
        texto_puntuacion_final = self.letra_pequena.render(
            f'Puntuación total: {self.puntuacion}', True, (255, 255, 255)
        )
        texto_reiniciar = self.letra_pequena.render(
            '¡Presiona R para reiniciar!', True, (255, 255, 255)
        )
        centro_x = self.screen_w // 2
        centro_y = self.screen_h // 2
        rect_perdiste = texto_perdiste.get_rect(center=(centro_x, centro_y - 70))
        rect_puntuacion_final = texto_puntuacion_final.get_rect(center=(centro_x, centro_y + 10))
        rect_reiniciar = texto_reiniciar.get_rect(center=(centro_x, centro_y + 50))
        self.screen.blit(texto_perdiste, rect_perdiste)
        self.screen.blit(texto_puntuacion_final, rect_puntuacion_final)
        self.screen.blit(texto_reiniciar, rect_reiniciar)

    def reiniciar_juego(self):
        self.game_over = False
        self.puntuacion = 0
        self.lista_tuberias = []
        self.fish.reset()
        pygame.mixer.music.stop()
        pygame.mixer.music.play(-1)

    def _dibujar_puntuacion(self):
        texto_puntuacion = self.letra_puntuacion.render(str(self.puntuacion), True, (255, 255, 255))
        self.screen.blit(texto_puntuacion, (20, 20))

    def swim(self, auto=False, pesos=None):
        if auto:
            decidir, pesos_usados = crear_politica(pesos)
            self.pesos_actuales = pesos_usados
        else:
            decidir = None

        while self.running:
            self.clock.tick(self.FPS)

            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    self.running = False

                if self.game_over and event.type == pygame.KEYDOWN and event.key == pygame.K_r:
                    #self.running = False
                    self.reiniciar_juego()

                if not self.game_over:
                    if event.type == self.evento_nueva_tuberia:
                        nueva_tuberia = tuberias(self.screen_w, self.hueco_entre_tuberias, self.imagen_tuberia)
                        self.lista_tuberias.append(nueva_tuberia)

                    if (not auto) and event.type == pygame.KEYDOWN:
                        if event.key == pygame.K_SPACE:
                            self.fish.flap()
                            self.sonido_salto.play()
                        elif event.key == pygame.K_RIGHT:
                            self.fish.right()
                        elif event.key == pygame.K_LEFT:
                            self.fish.left()

            if auto and (not self.game_over) and decidir is not None:
                dy, dx, vy = self._calcular_estado_completo()
                if decidir(dy, dx, vy):
                    self.fish.flap()
                    self.sonido_salto.play()

            if not self.game_over:
                for i in self.lista_tuberias:
                    i.mover_tuberias()
                self.lista_tuberias = [
                    t for t in self.lista_tuberias
                    if t.x > -self.imagen_tuberia.get_width()
                ]
                self.fish.update()

                fish_rect = self.fish.get_rect()

                if fish_rect.top <= 0 or fish_rect.bottom >= self.screen_h:
                    self.game_over = True

                for tuberia in self.lista_tuberias:
                    for tuberia_rect in tuberia.get_rects():
                        if fish_rect.colliderect(tuberia_rect):
                            self.game_over = True
                            break
                    if self.game_over:
                        break

                    if tuberia.x < fish_rect.left and not tuberia.pasada:
                        self.puntuacion += 1
                        tuberia.pasada = True
                        #print(f'Puntuación actual: {self.puntuacion}')

            #self.screen.fill("skyblue3")
            self.screen.blit(self.fondo_marino, (0, 0))

            for tuberia in self.lista_tuberias:
                tuberia.dibujar_tuberias(self.screen)

            self.fish.draw(self.screen)
            if not self.game_over:
                self._dibujar_puntuacion()

            if self.game_over:
                self._dibujar_game_over()

            pygame.display.flip()

        pygame.quit()