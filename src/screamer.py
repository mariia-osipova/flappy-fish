import pygame
# import time

from game import Game

class Scream(Game):
    def __init__(self):
        super().__init__(self.screen_w, self.screen_h)

    # def scream(self):
    #     self.screen = pygame.image.load(img).convert_alpha()