import pygame
from fish import Fish
from screamer import Scream
import numpy as np

class SwimFish:
    def __init__(self):
        pygame.init()
        self.h = 720
        self.w = 720
        self.screen = pygame.display.set_mode((self.w, self.h))
        self.clock = pygame.time.Clock()
        self.running = True

        self.fish = Fish(x = self.w//2, y = self.h // 2 - 75 , size = (100, 100), image =  '../data/img/img_1.png')

    def swim(self):
        while self.running:
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    self.running = False
                if event.type == pygame.KEYDOWN:
                    if event.key == pygame.K_SPACE:
                        self.fish.flap()
                    elif event.key == pygame.K_RIGHT:
                        self.fish.right()
                    elif event.key == pygame.K_LEFT:
                        self.fish.left()
                
                
            self.fish.update()

            self.screen.fill("skyblue3")
            self.fish.draw(self.screen)
            pygame.display.flip()
            self.clock.tick(60)

        pygame.quit()