#the parent class that manipulates the game: the start and the end, cycles, etc

import pygame
import random

class Game:
    def __init__(self):
        pygame.init()
        pygame.mixer.init()

        self.FPS = 120

        self.screen_w = 1000
        self.screen_h = 600

        self.screen = pygame.display.set_mode((self.screen_w, self.screen_h))

        self.music_path = "data/audios/linkin park fondo.ogg"
        pygame.mixer.music.load(self.music_path)
        pygame.mixer.music.play(-1)
        self.sonido_salto = pygame.mixer.Sound("data/audios/efecto bubble.ogg")
        self.fondo_marino = pygame.image.load("data/img/fondo verde.png").convert()
        self.fondo_marino = pygame.transform.scale(self.fondo_marino, (self.screen_w, self.screen_h))
        self.imagen_tuberia = pygame.image.load("data/img/alga.png").convert_alpha()
        self.imagen_tuberia = pygame.transform.scale(self.imagen_tuberia,(70,400))
        self.hueco_entre_tuberias=300
        self.evento_nueva_tuberia = pygame.USEREVENT 
        pygame.time.set_timer(self.evento_nueva_tuberia,1500)

        self.lista_tuberias = []      
