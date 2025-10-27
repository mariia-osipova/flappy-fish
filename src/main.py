import pygame
from fish import Fish
from move_fish import SwimFish

#
# pygame.init()
# h = 720
# w = 1280
# V = 1.3
# dt = 0
#
# size = (150, 150)
# screen = pygame.display.set_mode((w, h))
# clock = pygame.time.Clock()
# running = True
#
# img = '../data/img/img_1.png'
# fish = Fish(size[1]//2, size[0]//2, size, img, velocity=1.3)
# fish_image = pygame.image.load(img).convert_alpha()
# fish_image = pygame.transform.scale(fish_image, (size[0], size[1]))
#
# # player_rect = pygame.Rect(w//2 - size[0]//2, h//2 - size[1]//2, size[0], size[1])
#
# player_rect = fish_image.get_rect(center=(w//2, h//2))
#
# while running:
#     for event in pygame.event.get():
#         if event.type == pygame.QUIT:
#             running = False
#
#     keys = pygame.key.get_pressed()
#     if keys[pygame.K_w]:
#         player_rect.y -= 5*V
#     if keys[pygame.K_s]:
#         player_rect.y += 5*V
#     if not keys[pygame.K_w]:
#         player_rect.y += 5*(V+0.7)
#
#     screen.fill("skyblue3")
#     screen.blit(fish_image, player_rect)
#     pygame.display.flip()
#     clock.tick(60)
#
# pygame.quit()

if __name__ == "__main__":
    game = SwimFish()
    game.swim()