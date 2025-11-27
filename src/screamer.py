import pygame
# import time

from game import Game

# class Scream(Game):
#     def __init__(self):
#         super().__init__(self.screen_w, self.screen_h)
#
#     # def scream(self):
#     #     self.screen = pygame.image.load(img).convert_alpha()
#

class Screamer:
    def __init__(self, imagen, sonido=None, duracion_ms=1000):
        """
        imagen: Surface de pygame (ya cargada)
        sonido: Sound de pygame (opcional)
        duracion_ms: cuánto dura en milisegundos
        """
        self.imagen = imagen
        self.sonido = sonido
        self.duracion_ms = duracion_ms

class ScreamerManager:
    def __init__(self, pantalla, screamers_dict):
        """
        pantalla: surface principal (screen)
        screamers_dict: dict con {"nombre": Screamer, ...}
        """
        self.pantalla = pantalla
        self.screamers = screamers_dict

        self.activo = None      # Screamer actual
        self.tiempo_restante = 0  # en ms