import pygame

pygame.init()
screen = pygame.display.set_mode((1280, 720))
clock = pygame.time.Clock()
running = True

player_rect = pygame.Rect(100, 100, 50, 50)

while running:
    for event in pygame.event.get():
        if event.type == pygame.QUIT:
            running = False

    keys = pygame.key.get_pressed()
    if keys[pygame.K_w]:
        player_rect.y -= 5
    if keys[pygame.K_s]:
        player_rect.y += 5
    if keys[pygame.K_a]:
        player_rect.x -= 5
    if keys[pygame.K_d]:
        player_rect.x += 5

    screen.fill("skyblue3")

    pygame.draw.rect(screen, (0, 0, 0), player_rect)

    pygame.display.flip()

    clock.tick(60)

pygame.quit()