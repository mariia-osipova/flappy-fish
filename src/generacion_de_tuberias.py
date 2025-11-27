import pygame
import random


class tuberias:
    def __init__(self, x, hueco, imagen):
        self.imagen_tuberia = imagen
        self.altura_referencia = random.randint(150, 450)
        self.x = x
        self.hueco = hueco
        self.velocidad = 4
        self.tubo_arriba = self.imagen_tuberia.get_rect(midbottom = (x, self.altura_referencia - hueco // 2))
        self.tubo_abajo = self.imagen_tuberia.get_rect(midtop = (x, self.altura_referencia + hueco // 2))
        self.pasada = False

        self.gap_y = self.altura_referencia

    def dibujar_tuberias(self,screen):
        screen.blit(pygame.transform.flip(self.imagen_tuberia, False, True), self.tubo_arriba)
        screen.blit(self.imagen_tuberia, self.tubo_abajo)

    def mover_tuberias(self):
        self.x -= self.velocidad
        self.tubo_arriba.x = self.x
        self.tubo_abajo.x = self.x

    def get_rects(self):
        return [self.tubo_arriba, self.tubo_abajo]

    def top_rect(self):
        return self.tubo_arriba