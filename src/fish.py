#child class from Screen, i think we need to redefine the Screen Class as the child class of Game

import pygame

class Fish:
    def __init__(self, x, y, size, image):

        self.size = size
        self.image = pygame.image.load(image).convert_alpha()
        self.image = pygame.transform.scale(self.image, (size[0], size[1]))
        self.rect = self.image.get_rect(center = (x, y))

        self.velocity = 0
        self.gravity = 0.4
        # self.acceleration = 1.5
        self.jump_strength = -10
        self.max_fall_speed = 100
        self.air_resistance = 0.9

        # self.clock = pygame.time.Clock()
        # self.dt = self.clock.tick(60) / 1000.0  # (msec --> sec)

    def flap(self):
        self.velocity = self.jump_strength

    def right(self):
        self.rect.x += 5

    def left(self):
        self.rect.x -= 5

    def update(self):
        self.velocity += self.gravity

        if self.velocity > self.max_fall_speed:
            self.velocity = self.max_fall_speed

        self.rect.y += self.velocity

        #if self.rect.top < 0 :
        #    self.rect.top = 0
        #    self.velocity = 0

        #if self.rect.bottom > self.screen_h:
        #    self.rect.bottom = self.screen_h
        #    self.velocity = 0
        #
        # if self.rect.left < 0:
        #     self.rect.left = self.screen_w
        #
        # if self.rect.right > self.screen_w:
        #     self.rect.right = 0

    def draw(self, screen):
        screen.blit(self.image, self.rect)

    def get_rect(self):
        return self.rect