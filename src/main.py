import pygame
from src.game import Game
from src.swim_fish import SwimFish
from src.menu import Menu
from ml.vector_w import random_vector
from ml.genetics import nueva_generacion

if __name__ == '__main__':
    base_game = Game()
    current_state = 'MENU'
    menu = Menu(base_game.screen, base_game.screen_w, base_game.screen_h)
    running = True
    while running:
        if current_state == 'MENU':
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    running = False
                selection = menu.manejar_eventos(event)
                if selection == 'SINGLE':
                    current_state = 'SINGLE'
                elif selection == 'EVOLUTIVO':
                    current_state = 'EVOLUTIVO'

            delta_time = base_game.clock.tick(base_game.FPS) / 1000.0
            base_game.frame_timer += delta_time
            if base_game.frame_timer >= 1.0 / base_game.frame_rate:
                base_game.frame_index = (base_game.frame_index + 1) % len(base_game.background_frames)
                base_game.frame_timer = 0

            current_frame = base_game.background_frames[base_game.frame_index]
            base_game.screen.blit(current_frame, (0, 0))
            menu.dibujar()
            pygame.display.flip()

        elif current_state == 'SINGLE':
            juego_manual = SwimFish(x=150, y=300, size=(90, 90), image="../data/img/fish1.png")
            resultado = juego_manual.swim(auto=False)
            if resultado == 'MENU':
                current_state = 'MENU'
            elif resultado == 'QUIT':
                running = False

        elif current_state == 'EVOLUTIVO':
            juego_auto = SwimFish(x=150, y=300, size=(30, 30), image="../data/img/fish1.png")

            tam_poblacion = 100
            num_epocas = 100
            tiempo_max_epoca = 120
            umbral_distancia = 3
            umbral_parada = 50

            pesos_poblacion = [random_vector() for _ in range(tam_poblacion)]
            mejor_global = 0

            for epoca in range(num_epocas):
                juego_auto.generacion = epoca + 1
                pesos_finales, fitnesses, estado = juego_auto.swim_population(
                    pesos_poblacion,
                    tiempo_max=tiempo_max_epoca,
                    umbral_distancia=umbral_distancia,
                )

                if estado == 'QUIT':
                    running = False
                    break
                if estado == 'MENU':
                    break
                if not pesos_finales or not fitnesses:
                    break

                mejor_epoca = max(fitnesses)
                juego_auto._actualizar_fitness_hist(mejor_epoca)
                promedio_epoca = sum(fitnesses) / len(fitnesses)

                if mejor_epoca > mejor_global:
                    mejor_global = mejor_epoca

                juego_auto._actualizar_fitness_hist(mejor_epoca)

                cantidad_sobre_umbral = sum(1 for f in fitnesses if f >= umbral_parada)
                if epoca >= 10 and cantidad_sobre_umbral >= tam_poblacion // 2:
                    break

                pesos_poblacion = nueva_generacion(
                    pesos_finales,
                    fitnesses,
                    prob_mut=0.1,
                    elitismo=2,
                )

            current_state = 'MENU'
    pygame.quit()