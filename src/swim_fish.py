#child class from Fish

import pygame
from fish import Fish
from screamer import Scream
import numpy as np

class SwimFish(Fish):

    def __init__(self, x, y, size, image, screen_w, screen_h):

        pygame.init()

        self.clock = pygame.time.Clock()
        self.running = True

        # self.dt = self.clock.tick(60) / 1000.0

        super().__init__(x, y, size, image, screen_w, screen_h)

        self.fish = Fish(x, y, size, image, screen_w, screen_h)

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
                    # elif event.key == pygame.K_UP:
                    #     self.fish.scream()
                
            self.fish.update()

            self.screen.fill("skyblue3")
            self.fish.draw(self.screen)
            pygame.display.flip()
            self.clock.tick(60)

        pygame.quit()