#child class from Screen, i think we need to redefine the Screen Class as the child class of Game

import pygame

class Fish:
    def __init__(self, x, y, size, image):

        self._start_pos = (x, y)

        self.size = size
        self.original_image = pygame.image.load(image).convert_alpha()
        self.original_image = pygame.transform.scale(self.original_image, (size[0], size[1]))
        self.image = self.original_image
        self.rect = self.image.get_rect(center = (x, y))
        self.mask = pygame.mask.from_surface(self.image)

        self.velocity = 0
        self.gravity = 0.3
        self.jump_strength = -10
        self.max_fall_speed = 100
        self.air_resistance = 0.9


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
        self._rotar_pez()

    def draw(self, screen):
        screen.blit(self.image, self.rect)

    def get_rect(self):
        return self.rect
    
    def _rotar_pez(self):
        angulo = self.velocity * 3
        
        if self.velocity > 0: 
            angulo = min(angulo, 90) 
        else: 
            angulo = max(angulo, -30) 

        self.image = pygame.transform.rotate(self.original_image, -angulo) 
        
        old_center = self.rect.center
        self.rect = self.image.get_rect(center=old_center)
        self.mask = pygame.mask.from_surface(self.image)

    def reset(self):
        self.rect.center = self._start_pos
        self.velocity = 0