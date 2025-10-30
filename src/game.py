#the parent class that manipulates the game: the start and the end, cycles, etc

import pygame

class Game:
    def __init__(self, screen_w: int, screen_h: int):
        pygame.init()
        self.screen_w = screen_w
        self.screen_h = screen_h

        self.screen_w = 1000
        self.screen_h = 600

        self.screen = pygame.display.set_mode((self.screen_w, self.screen_h))