def calcular_estado(rect_jugador, proxima_pipe):
    """Devuelve (dy, dx). vy lo tomás de player.vy."""
    # dy positivo significa que el hueco está por encima del jugador (hay que subir)
    dy = rect_jugador.centery - proxima_pipe.gap_y
    dx = proxima_pipe.top_rect().left - rect_jugador.right
    return dy, dx
