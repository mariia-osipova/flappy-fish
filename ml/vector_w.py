# w0 + w1 * dy + w2 * (dy)^2 + w3 * dx +w4 * (dx)^2 +w5 * Vy > 0
import random

#so i'll start with implementation of generating new random vectors with dim 6

def random_vector(low=-0.5, high=0.5):
    """Devuelve un vector de 6 pesos aleatorios en [low, high]."""
    return [random.uniform(low, high) for _ in range(6)]