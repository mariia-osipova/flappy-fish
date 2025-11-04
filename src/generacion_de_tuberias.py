import pygame
import random


class tuberias:
    def __init__(self, x, hueco, imagen):
        self.imagen_tuberia=imagen
        self.altura= random.randint(150,300)
        self.hueco=hueco
        self.velocidad=4
        self.tuboarriba=self.imagen_tuberia.get_rect(midbottom=(x,self.altura))
        self.tuboabajo=self.imagen_tuberia.get_rect(midtop=(x,self.altura+self.hueco))
    
    def dibujar_tuberias(self,screen):
        screen.blit(self.imagen_tuberia,self.tuboarriba)
        screen.blit(self.imagen_tuberia,self.tuboabajo)

    def mover_tuberias(self):
        self.tuboarriba.x= self.tuboarriba.x - self.velocidad
        self.tuboabajo.x= self.tuboabajo.x - self.velocidad

        


