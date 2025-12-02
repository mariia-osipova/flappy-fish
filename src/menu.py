import pygame

class Menu:
    def __init__(self, screen, screen_w, screen_h):
        self.screen = screen
        self.screen_w = screen_w
        self.screen_h = screen_h

        self.color_blanco = (255, 255, 255)
        self.color_gris = (150, 150, 150)
        self.color_sombra = (0, 0, 0)
        self.offset = 2
        
        self.letra_titulo = pygame.font.Font(None, 100)
        self.letra_opcion = pygame.font.Font(None, 50)
        
        self.titulo = self.letra_titulo.render('¡FLAPPY FISH!', True, self.color_blanco)
        self.opcion_single = self.letra_opcion.render('1. Single Player (Juego Manual)', True, self.color_blanco)
        self.opcion_evolutivo = self.letra_opcion.render('2. Simulación (Algoritmo Evolutivo)', True, self.color_gris)

        self.rect_titulo = self.titulo.get_rect(center=(screen_w // 2, screen_h // 4))
        self.rect_single = self.opcion_single.get_rect(center=(screen_w // 2, screen_h // 2))
        self.rect_evolutivo = self.opcion_evolutivo.get_rect(center=(screen_w // 2, screen_h // 2 + 70))

        self.titulo_sombra = self.letra_titulo.render('¡FLAPPY FISH!', True, self.color_sombra)
        self.opcion_single_sombra = self.letra_opcion.render('1. Single Player (Juego Manual)', True, self.color_sombra)
        self.opcion_evolutivo_sombra = self.letra_opcion.render('2. Simulación (Algoritmo Evolutivo)', True, self.color_sombra)
        
        self.seleccion = None

    def dibujar(self):
        sombra_rect = self.rect_titulo.move(self.offset, self.offset)
        self.screen.blit(self.titulo_sombra, sombra_rect)
        self.screen.blit(self.titulo, self.rect_titulo)

        sombra_rect_single = self.rect_single.move(self.offset, self.offset)
        self.screen.blit(self.opcion_single_sombra, sombra_rect_single)
        self.screen.blit(self.opcion_single, self.rect_single)

        sombra_rect_evolutivo = self.rect_evolutivo.move(self.offset, self.offset)
        self.screen.blit(self.opcion_evolutivo_sombra, sombra_rect_evolutivo)
        self.screen.blit(self.opcion_evolutivo, self.rect_evolutivo)

    def manejar_eventos(self, event):
        if event.type == pygame.MOUSEBUTTONDOWN:
            if event.button == 1: 
                mouse_pos = event.pos
                
                if self.rect_single.collidepoint(mouse_pos):
                    self.seleccion = 'SINGLE'
                    return self.seleccion 
                
                if self.rect_evolutivo.collidepoint(mouse_pos):
                    self.seleccion = 'EVOLUTIVO' 
                    return self.seleccion

        if event.type == pygame.KEYDOWN:
            if event.key == pygame.K_1:
                self.seleccion = 'SINGLE'
                return self.seleccion
            elif event.key == pygame.K_2:
                self.seleccion = 'EVOLUTIVO'
                return self.seleccion

        return None