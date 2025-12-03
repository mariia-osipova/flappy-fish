from ml.vector_w import random_vector

# pesos_default = [0.0, 0.015, 0.0, 0.002, 0.0, 0.025]

def crear_politica(pesos=None, low=-0.5, high=0.5):
    """
    if 'pesos' is None, generates new vector in range [low, high].
    if 'pesos' is a list of 6 num, uses it as initial values of w0, w1, ..., w5

    :returns:
        decidir(dy, dx, vy) -> bool
        pesos_usados        -> lista[6]
    """
    if pesos is None:
        pesos = random_vector(low, high)
        # pesos = pesos_default

    w = list(pesos)

    def decidir(dy, dx, vy):
        dy_n = dy / 400.0
        dx_n = dx / 400.0
        vy_n = vy / 300.0

        valor = (w[0] +
                 w[1] * dy_n +
                 w[2] * (dy_n * dy_n) +
                 w[3] * dx_n +
                 w[4] * (dx_n * dx_n) +
                 w[5] * vy_n)

        # print(f"dy={dy:.1f}, dx={dx:.1f}, vy={vy:.2f}, valor={valor:.2f}") #debug
        return valor > 0

    return decidir, pesos