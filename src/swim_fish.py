import pygame
from fish import Fish
from generacion_de_tuberias import tuberias
from game import Game

class SwimFish(Fish):
    def __init__(self, x, y, size, image):
        pygame.init()
        
        self.game = Game()
        
        self.screen = self.game.screen
        self.FPS = self.game.FPS
        self.evento_nueva_tuberia = self.game.evento_nueva_tuberia
        self.hueco_entre_tuberias = self.game.hueco_entre_tuberias
        self.imagen_tuberia = self.game.imagen_tuberia
        self.lista_tuberias = self.game.lista_tuberias
        
        self.clock = pygame.time.Clock()
        self.running = True
        
        super().__init__(x, y, size, image)
        self.fish = Fish(x, y, size, image)

    def swim(self):
        while self.running:
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    self.running = False
                if event.type == self.evento_nueva_tuberia:
                    nueva_tuberia = tuberias(1000, self.hueco_entre_tuberias, self.imagen_tuberia)
                    self.lista_tuberias.append(nueva_tuberia)
                if event.type == pygame.KEYDOWN:
                    if event.key == pygame.K_SPACE:
                        self.fish.flap()
                    elif event.key == pygame.K_RIGHT:
                        self.fish.right()
                    elif event.key == pygame.K_LEFT:
                        self.fish.left()

            for i in self.lista_tuberias:
                i.mover_tuberias()
            
            self.lista_tuberias = [t for t in self.lista_tuberias]
            
            self.screen.fill("skyblue3")
            
            for tuberia in self.lista_tuberias:
                tuberia.dibujar_tuberias(self.screen)
            
            self.fish.update()
            self.fish.draw(self.screen)
            
            pygame.display.flip()
            self.clock.tick(self.FPS)

        pygame.quit()