# w0 + w1 * dy + w2 * (dy)^2 + w3 * dx +w4 * (dx)^2 +w5 * Vy > 0
import random
import sys

#so i'll start with implementation of generating new random vectors with dim 6

import numpy as np

class VectorW:
    def __init__(self, vector):
        self.vector = vector

    def random_vector(self):
        self.vector = [random.randint(-sys.maxsize, sys.maxsize) for i in range(6)]
        return self.vector