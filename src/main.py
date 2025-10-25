import pygame
from jedi.debug import speed

pygame.init()
h = 720
w = 1280
V = 1.3

size = (150, 150)
screen = pygame.display.set_mode((w, h))
clock = pygame.time.Clock()
running = True

player_image = pygame.image.load('../data/img/img_1.png').convert_alpha()
player_image = pygame.transform.scale(player_image, (size[0], size[1]))

# player_rect = pygame.Rect(w//2 - size[0]//2, h//2 - size[1]//2, size[0], size[1])

player_rect = player_image.get_rect(center=(w//2, h//2))

while running:
    for event in pygame.event.get():
        if event.type == pygame.QUIT:
            running = False

    keys = pygame.key.get_pressed()
    if keys[pygame.K_w]:
        player_rect.y -= 5*V
    if keys[pygame.K_s]:
        player_rect.y += 5*V
    if not keys[pygame.K_w]:
        player_rect.y += 5*(V+0.7)

    screen.fill("skyblue3")
    screen.blit(player_image, player_rect)
    pygame.display.flip()
    clock.tick(60)

pygame.quit()