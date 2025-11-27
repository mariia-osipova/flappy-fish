from ml.vector_w import random_vector

# def crear_politica(low, high):
#     """Devuelve una función (dy, dx, vy) -> bool (True: aletear)."""
#
#     pesos = random_vector(low, high)
#
#     def decidir(dy, dx, vy):
#         valor = (pesos[0] + pesos[1]*dy + pesos[2]*(dy*dy) +
#                  pesos[3]*dx + pesos[4]*(dx*dx) + pesos[5]*vy)
#         return valor > 0
#     return decidir

pesos_default = [0.0, 0.015, 0.0, 0.002, 0.0, 0.025]

def crear_politica(pesos=None, low=-0.5, high=0.5):
    """
    if 'pesos' is None, generates new vector in range [low, high].
    if 'pesos' is a list of 6 num, uses it as initial values of w0, w1, ..., w5

    :returns:
        decidir(dy, dx, vy) -> bool
        pesos_usados        -> lista[6]
    """
    if pesos is None:
        # pesos = random_vector(low, high)
        pesos = pesos_default

    w = list(pesos)

    def decidir(dy, dx, vy):
        valor = (w[0] +
                 w[1] * dy +
                 w[2] * (dy * dy) +
                 w[3] * dx +
                 w[4] * (dx * dx) +
                 w[5] * vy)
        # print(f"dy={dy:.1f}, dx={dx:.1f}, vy={vy:.2f}, valor={valor:.2f}") #debug
        return valor > 0

    return decidir, pesos

# def crear_politica(pesos=None, low=-0.5, high=0.5):
#     def decidir(dy, dx, vy):
#         return True
#     return decidir, [0, 0, 0, 0, 0, 0]