import pygame
# import time

from game import Game

class Scream(Game):
    def __init__(self):
        super().__init__()
        self.mostrar_jumpscare=False
        self.ruidar=False
        self.tiempo_jumpscare = pygame.time.get_ticks()
        self.definir_jumpscare()

    def definir_jumpscare(self):
        self.jumpscare_imagen=pygame.image.load('data/img/img.png').convert_alpha()
        self.jumpscare_imagen = pygame.transform.scale(self.jumpscare_imagen, (self.screen_w, self.screen_h))
        self.jumpscare_ruido=pygame.mixer.Sound('data/audios/scream.mp3')

    def dibujar_jumpscare(self):
        if self.mostrar_jumpscare and self.jumpscare_imagen:
            self.screen.blit(self.jumpscare_imagen, (0,0))

    def asustar(self):
        if self.jumpscare_imagen and self.jumpscare_ruido:
            self.jumpscare_ruido.play()
            self.mostrar_jumpscare=True
        if self.mostrar_jumpscare and self.jumpscare_imagen:
            self.screen.blit(self.jumpscare_imagen, (0,0))
        self.tiempo_jumpscare = pygame.time.get_ticks()
            
    def actualizar_jumpscare(self):
        if self.mostrar_jumpscare:
            if pygame.time.get_ticks() - self.tiempo_jumpscare > 2500:  
                self.mostrar_jumpscare = False

    # def scream(self):
    #     self.screen = pygame.image.load(img).convert_alpha()