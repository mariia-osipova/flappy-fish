import pygame
from fish import Fish
from swim_fish import SwimFish
from game import Game
if __name__ == "__main__":
    if __name__ == "__main__":
        game = SwimFish(x=150, y=300, size=(50, 50), image="../data/img/img_1.png")
        # game.swim(auto=False)
        game.swim(auto=True)