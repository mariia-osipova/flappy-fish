import pygame
from game import Game
from swim_fish import SwimFish
from menu import Menu

if __name__ == '__main__':
    base_game = Game()
    current_state = 'MENU'
    menu = Menu(base_game.screen, base_game.screen_w, base_game.screen_h)
    running = True
    while running:
        if current_state == 'MENU':
            #base_game.clock.tick(base_game.FPS)

            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    running = False
                selection = menu.manejar_eventos(event)
                if selection == 'SINGLE':
                    current_state = 'SINGLE'
                elif selection == 'EVOLUTIVO':
                    current_state = 'EVOLUTIVO_PENDIENTE'

            #base_game.screen.blit(base_game.fondo_marino, (0, 0))
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
            juego_manual = SwimFish(x=150, y=300, size=(30, 30), image="../data/img/fish1.png")

            resultado = juego_manual.swim(auto=False)

            if resultado == 'MENU':
                current_state = 'MENU'
            elif resultado == 'QUIT':
                running = False

        elif current_state == 'EVOLUTIVO_PENDIENTE':
            juego_auto = SwimFish(x=150, y=300, size=(30, 30), image="../data/img/fish1.png")

            resultado = juego_auto.swim_population()

            # print("El modo Algoritmo Evolutivo todavía no esta terminado!")
            # current_state = 'MENU'

            if resultado == 'MENU':
                current_state = 'MENU'
            elif resultado == 'QUIT':
                running = False

            #TODO
            #game.swim(auto=True)

    pygame.quit()