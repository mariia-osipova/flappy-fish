import random
import math

def seleccionar_proporcional(pesos_poblacion, fitnesses):
    fitness_pos = [max(f, 0.0) + 1e-6 for f in fitnesses]
    total = sum(fitness_pos)
    if total == 0:
        return random.choice(pesos_poblacion)
    r = random.uniform(0, total)
    acum = 0.0
    for w, fit in zip(pesos_poblacion, fitness_pos):
        acum += fit
        if acum >= r:
            return w
    return pesos_poblacion[-1]

def cruce_uniforme(p1, p2):
    largo = min(len(p1), len(p2))
    hijo = []
    for i in range(largo):
        if random.random() < 0.5:
            hijo.append(p1[i])
        else:
            hijo.append(p2[i])
    return hijo

def mutar(pesos, prob_gen=0.1, sigma=0.5):
    hijo = list(pesos)
    for i in range(len(hijo)):
        if random.random() < prob_gen:
            hijo[i] += random.gauss(0.0, sigma)
    return hijo

def nueva_generacion(pesos_poblacion, fitnesses, prob_mut=0.1, elitismo=2):
    combinados = list(zip(pesos_poblacion, fitnesses))
    combinados.sort(key=lambda x: x[1], reverse=True)
    nuevos = [w for w, f in combinados[:elitismo]]

    n = len(pesos_poblacion)
    while len(nuevos) < n:
        p1 = seleccionar_proporcional(pesos_poblacion, fitnesses)
        p2 = seleccionar_proporcional(pesos_poblacion, fitnesses)
        hijo = cruce_uniforme(p1, p2)
        hijo = mutar(hijo, prob_gen=prob_mut)
        nuevos.append(hijo)

    return nuevos