#the parent class that manipulates the game: the start and the end, cycles, etc

import pygame

class Game:
    def __init__(self):
        pygame.init()

        self.FPS = 120

        self.screen_w = 1000
        self.screen_h = 600

        self.screen = pygame.display.set_mode((self.screen_w, self.screen_h))