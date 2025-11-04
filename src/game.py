#the parent class that manipulates the game: the start and the end, cycles, etc

import pygame
import random

class Game:
    def __init__(self):
        pygame.init()

        self.FPS = 120

        self.screen_w = 1000
        self.screen_h = 600

        self.screen = pygame.display.set_mode((self.screen_w, self.screen_h))

        self.imagen_tuberia = pygame.image.load("data\img\image.png").convert()
        self.imagen_tuberia = pygame.transform.scale(self.imagen_tuberia,(70,400))
        self.hueco_entre_tuberias=200
        self.evento_nueva_tuberia = pygame.USEREVENT 
        pygame.time.set_timer(self.evento_nueva_tuberia,1500)

        self.lista_tuberias = []      
