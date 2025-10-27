import pygame
import numpy as np

class Fish:
    def __init__(self, x, y, size, image = '../data/img/img.png', screen_width = 1280, screen_height = 720):
        self.size = size
        self.image = pygame.image.load(image).convert_alpha()
        self.image = pygame.transform.scale(self.image, (size[0], size[1]))
        self.rect = self.image.get_rect(center=(x, y))

        self.screen_width = screen_width
        self.screen_height = screen_height

        self.velocity = 0
        self.gravity = 0.5
        self.acceleration = 0.3
        self.jump_strength = -10
        self.max_fall_speed = 500
        self.air_resistance = 1

    # def move_input(self, keys):
    #
    #     if keys[pygame.K_w] :
    #         self.flap()
    #     if keys[pygame.K_s]:
    #         self.move_down()
    #
    #     if not keys[pygame.K_w]:
    #         self.apply_gravity()

    def flap(self):
        self.velocity = self.jump_strength

    def right(self):
        self.rect.x += self.velocity

    def left(self):
        self.rect.x -= self.velocity

    # def birds_fisics(self):
    #     self.rect.y += self.velocity

    def update(self):
        self.velocity += self.acceleration
        self.velocity *= self.air_resistance

        self.rect.y += self.velocity
        # self.rect.x -= self.velocity
        # self.rect.x += np.cos(self.velocity)

        if self.rect.top < 0:
            self.rect.top = 0
            self.velocity = 0

        if self.rect.bottom > self.screen_height:
            self.rect.bottom = self.screen_height
            self.velocity_y = 0

        if self.rect.left < 0:
            self.rect.left = self.screen_width
            # self.velocity_x = 0

        if self.rect.right > self.screen_width:
            self.rect.right = 0

    def draw(self, screen):
        screen.blit(self.image, self.rect)

    # def get_position(self):
    #     return (self.rect.x, self.rect.y)

    # def set_position(self, x, y):
    #     self.rect.center = (x, y)