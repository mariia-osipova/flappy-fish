# --------------------- Automatización del juego por la máquina ---------------------
import pygame, sys, random

# ----- Parámetros básicos -----
WIDTH, HEIGHT = 480, 640
FPS = 60
GRAVITY = 0.45
JUMP_V = -8.5
SCROLL_X = 3
PIPE_GAP = 150
PIPE_WIDTH = 70
SPAWN_MS = 1500
PIPE_MIN = 80
PIPE_MAX = HEIGHT - PIPE_GAP - 80
PLAYER_X = 100
PLAYER_SIZE = 28
BG = (15, 18, 25)
PIPE_COLOR = (76, 175, 80)
PLAYER_COLOR = (33, 150, 243)

# --------- Clases básicas ----------
class Player:
    def __init__(self, x=PLAYER_X, y=HEIGHT // 2):
        self.x = x
        self.y = y
        self.vy = 0.0

    def rect(self):
        return pygame.Rect(int(self.x - PLAYER_SIZE // 2),
                           int(self.y - PLAYER_SIZE // 2),
                           PLAYER_SIZE, PLAYER_SIZE)


class Pipe:
    def __init__(self, x, gap_y):
        self.x = x
        self.gap_y = gap_y  # centro del hueco

    def top_rect(self):
        return pygame.Rect(int(self.x), 0, PIPE_WIDTH, int(self.gap_y - PIPE_GAP / 2))

    def bot_rect(self):
        return pygame.Rect(int(self.x), int(self.gap_y + PIPE_GAP / 2),
                           PIPE_WIDTH, int(HEIGHT - (self.gap_y + PIPE_GAP / 2)))

    def mover(self, dx):
        self.x += dx


# --------- Control de límites del jugador ----------
def restringir_movimiento(jugador):
    """
    Evita que el jugador salga de los límites de la pantalla.
    Si toca el techo o el piso, se lo mantiene dentro del área visible
    y se anula su velocidad vertical solo si intenta salir.
    """
    # límite superior (techo)
    if jugador.y < PLAYER_SIZE // 2:
        jugador.y = PLAYER_SIZE // 2
        if jugador.vy < 0:  # solo anular si iba hacia afuera
            jugador.vy = 0

    # límite inferior (piso)
    if jugador.y > HEIGHT - PLAYER_SIZE // 2:
        jugador.y = HEIGHT - PLAYER_SIZE // 2
        if jugador.vy > 0:  # solo anular si iba hacia afuera
            jugador.vy = 0


# --------- Funciones auxiliares ----------
def crear_politica(pesos):
    """Devuelve una función (dy, dx, vy) -> bool (True: aletear)."""
    def decidir(dy, dx, vy):
        valor = (pesos[0] + pesos[1]*dy + pesos[2]*(dy*dy) +
                 pesos[3]*dx + pesos[4]*(dx*dx) + pesos[5]*vy)
        return valor > 0
    return decidir


def calcular_estado(rect_jugador, proxima_pipe):
    """Devuelve (dy, dx). vy lo tomás de player.vy."""
    # dy positivo significa que el hueco está por encima del jugador (hay que subir)
    dy = rect_jugador.centery - proxima_pipe.gap_y
    dx = proxima_pipe.top_rect().left - rect_jugador.right
    return dy, dx


# --------- Función principal de simulación ----------
def simular(pesos, segundos=40, mostrar=True):
    """
    Simula el vuelo con la política definida por 'pesos'.
    - No hay colisiones, ni score, ni reinicio.
    - 'segundos' controla la duración de la demo.
    - Si 'mostrar=False', no dibuja (útil si después quieren entrenar y acelerar).
    """
    decidir = crear_politica(pesos)

    pygame.init()
    pantalla = pygame.display.set_mode((WIDTH, HEIGHT)) if mostrar else pygame.Surface((WIDTH, HEIGHT))
    reloj = pygame.time.Clock()

    jugador = Player()
    pipes = []
    temporizador_spawn = 0

    # Pipe inicial para que la política tenga datos desde el inicio
    pipes.append(Pipe(WIDTH + 20, random.randint(PIPE_MIN, PIPE_MAX)))

    corriendo = True
    tiempo_total = 0.0

    while corriendo:
        dt = reloj.tick(FPS)
        tiempo_total += dt / 1000.0

        # Permitir cerrar ventana si se muestra
        if mostrar:
            for e in pygame.event.get():
                if e.type == pygame.QUIT:
                    corriendo = False

        # Spawnear nuevas pipes
        temporizador_spawn -= dt
        if temporizador_spawn <= 0:
            hueco_y = random.randint(PIPE_MIN, PIPE_MAX)
            pipes.append(Pipe(WIDTH + 20, hueco_y))
            temporizador_spawn = SPAWN_MS

        # Mover pipes y eliminar las que salieron de pantalla
        for p in pipes:
            p.mover(-SCROLL_X)
        pipes = [p for p in pipes if p.x + PIPE_WIDTH > 0]

        # Determinar próxima pipe visible
        proxima_pipe = None
        for p in pipes:
            if p.top_rect().right >= jugador.rect().left:
                proxima_pipe = p
                break

        # Calcular estado y decidir si aletear
        if proxima_pipe:
            dy, dx = calcular_estado(jugador.rect(), proxima_pipe)
        else:
            dy, dx = jugador.rect().centery - (HEIGHT // 2), 200.0  # fallback si no hay pipes
        aletear = decidir(dy, dx, jugador.vy)

        # Física básica
        if aletear:
            jugador.vy = JUMP_V
        else:
            jugador.vy += GRAVITY
        jugador.y += jugador.vy

        restringir_movimiento(jugador)

        # Dibujar
        if mostrar:
            pantalla.fill(BG)
            pygame.draw.rect(pantalla, PLAYER_COLOR, jugador.rect())
            for p in pipes:
                pygame.draw.rect(pantalla, PIPE_COLOR, p.top_rect())
                pygame.draw.rect(pantalla, PIPE_COLOR, p.bot_rect())
            pygame.display.flip()

        # Limitar duración
        if tiempo_total >= segundos:
            corriendo = False

    if mostrar:
        pygame.quit()


# --------- DEMO opcional (no se ejecuta al importar) ----------
def _pedir_pesos_por_consola():
    print("Ingresá los 6 pesos w0..w5 separados por espacios (Enter usa por defecto).")
    s = input("w0 w1 w2 w3 w4 w5: ").strip()
    if not s:
        return [0.0, 0.015, 0.0, 0.002, 0.0, -0.25]
    try:
        valores = [float(x) for x in s.split()]
        if len(valores) != 6:
            raise ValueError
        return valores
    except Exception:
        print("Entrada inválida. Usando pesos por defecto.")
        return [0.0, 0.015, 0.0, 0.002, 0.0, -0.25]


if __name__ == "__main__":
    EJECUTAR_DEMO = True
else:
    EJECUTAR_DEMO = False

if EJECUTAR_DEMO:
    w = _pedir_pesos_por_consola()
    simular(w, segundos=40, mostrar=True)
    sys.exit()
#-------------------SCREAMERS-----------------------
import pygame

class Screamer:
    def __init__(self, imagen, sonido=None, duracion_ms=1000):
        """
        imagen: Surface de pygame (ya cargada)
        sonido: Sound de pygame (opcional)
        duracion_ms: cuánto dura en milisegundos
        """
        self.imagen = imagen
        self.sonido = sonido
        self.duracion_ms = duracion_ms


class ScreamerManager:
    def __init__(self, pantalla, screamers_dict):
        """
        pantalla: surface principal (screen)
        screamers_dict: dict con {"nombre": Screamer, ...}
        """
        self.pantalla = pantalla
        self.screamers = screamers_dict

        self.activo = None      # Screamer actual
        self.tiempo_restante = 0  # en ms

    def disparar(self, nombre):
        """Activa un screamer por nombre."""
        if nombre not in self.screamers:
            return # si no se cumple sale de la función sin hacer nada, y si lo cumple, prosigue

        self.activo = self.screamers[nombre]
        self.tiempo_restante = self.activo.duracion_ms

        # Reproducir sonido si tiene
        if self.activo.sonido is not None:
            self.activo.sonido.play()

    def update(self, dt_ms):
        """Actualizar el tiempo restante del screamer.
        dt_ms: milisegundos transcurridos desde el último frame.
        """
        if self.activo is None:
            return

        self.tiempo_restante -= dt_ms
        if self.tiempo_restante <= 0:
            self.activo = None
            self.tiempo_restante = 0

    def draw(self):
        """Dibujar el screamer encima de todo lo demás, si está activo."""
        if self.activo is None:
            return

        # Escalar la imagen para que ocupe toda la pantalla
        ancho, alto = self.pantalla.get_size()
        img = pygame.transform.scale(self.activo.imagen, (ancho, alto))
        self.pantalla.blit(img, (0, 0))

    def esta_activo(self):
        return self.activo is not None
# -------------------------------------------- CROQUIS MACHINE LEARNING --------------------------------------------
import random
from collections import defaultdict

# -----------------------------------------
# Acciones posibles del agente
# 0 = no saltar, 1 = saltar
# -----------------------------------------
ACTIONS = [0, 1]


# -----------------------------------------
# Entorno que envuelve al juego
# (croquis, NO usa aún tu código real)
# -----------------------------------------
class GameEnv:
    def __init__(self, game):
        """
        game: va a ser el objeto de juego Pygame.
        La idea es que en el futuro tenga estos métodos:

          - game.reset()
          - game.step(action) -> (reward, done)
          - game.get_state()  -> estado (lista/tupla de números)
        """
        self.game = game

    def reset(self):
        """
        Reinicia el juego y devuelve el estado inicial.
        En el futuro va a hacer algo como:

            self.game.reset()
            state = self.game.get_state()
            return state
        """
        raise NotImplementedError("Conectar con game.reset() y game.get_state()")

    def step(self, action):
        """
        Aplica la acción y avanza un paso de simulación.
        En el futuro va a hacer algo como:

            reward, done = self.game.step(action)
            next_state = self.game.get_state()
            return next_state, reward, done
        """
        raise NotImplementedError("Conectar con game.step(action) y game.get_state()")


# -----------------------------------------
# Agente: Q-Learning muy simple (croquis)
# -----------------------------------------
class Agent:
    def __init__(self, alpha=0.1, gamma=0.99, epsilon=0.2):
        self.alpha = alpha      # tasa de aprendizaje
        self.gamma = gamma      # descuento futuro
        self.epsilon = epsilon  # exploración
        # Q[(estado_discreto)][accion] = valor
        self.Q = defaultdict(lambda: [0.0 for _ in ACTIONS])

    def _discretize_state(self, state):
        """
        Convierte el estado continuo en algo discreto.
        Ejemplo típico del juego:
            state = [y_jugador, vy_jugador, dist_x_tubo, diff_y_gap]
        Solo idea croquis, podés cambiarlo.
        """
        # Versión croquis: supongo que state es una lista de números
        # y los agrupo de a 10 unidades.
        return tuple(int(x // 10) for x in state)

    def act(self, state, training=True):
        """
        Política ε-greedy:
          - con probabilidad epsilon, explora (elige random)
          # pregunta si no se entiende la política porque me la explicó mati jeje
          - si no, explota (elige la mejor acción según Q)
        """
        s = self._discretize_state(state)

        # Explorar
        if training and random.random() < self.epsilon:
            return random.choice(ACTIONS)

        # Explotar
        q_values = self.Q[s]
        best_action_idx = max(range(len(ACTIONS)), key=lambda a: q_values[a])
        return ACTIONS[best_action_idx]

    def learn(self, state, action, reward, next_state, done):
        """
        Regla de actualización de Q-Learning:
          Q(s,a) <- Q(s,a) + alpha * (target - Q(s,a))
        """
        s = self._discretize_state(state)
        ns = self._discretize_state(next_state)

        a_idx = ACTIONS.index(action)
        current_q = self.Q[s][a_idx]

        if done:
            target = reward
        else:
            next_best_q = max(self.Q[ns])
            target = reward + self.gamma * next_best_q

        self.Q[s][a_idx] = current_q + self.alpha * (target - current_q)


# -----------------------------------------
# Loop de entrenamiento (croquis)
# -----------------------------------------
def train(env, agent, n_episodes=10):
    """
    Bucle general de entrenamiento:
      para cada episodio:
        - resetear entorno
        - mientras no termine:
            elegir acción
            ejecutar acción
            aprender
    """
    for ep in range(n_episodes):
        state = env.reset()
        done = False
        total_reward = 0

        while not done:
            action = agent.act(state, training=True)
            next_state, reward, done = env.step(action)
            agent.learn(state, action, reward, next_state, done)
            state = next_state
            total_reward += reward

        print(f"Episodio {ep+1}: recompensa total = {total_reward}")


# -----------------------------------------
# Ejemplo de cómo se va a usar (croquis)
# NO va a funcionar todavía, es solo para hablarlo
# -----------------------------------------
if __name__ == "__main__":
    # desde ek archivo del juego habría que importar Game
    # game = Game()
    # env = GameEnv(game)
    # agent = Agent()
    # train(env, agent, n_episodes=20)
    pass
