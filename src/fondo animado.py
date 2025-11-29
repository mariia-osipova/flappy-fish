

from PIL import Image
import os

def extract_frames(gif_path, output_folder="data/img/fondo_animado"):
    if not os.path.exists(output_folder):
        os.makedirs(output_folder)
    try:
        img = Image.open(gif_path)
    except FileNotFoundError:
        print(f"ERROR: Archivo GIF no encontrado en {gif_path}")
        return

    frame = 0
    while True:
        try:
            img.seek(frame)
            img.save(os.path.join(output_folder, f"frame_{frame:03d}.png"))
            frame += 1
        except EOFError:
            break

    print(f"Extracción finalizada. Se guardaron {frame} frames en: {output_folder}")

if __name__ == '__main__':
    gif_source_path = "data/img/descarga.gif"
    output_folder_path = "data/img/fondo_animado"

    print(f"Iniciando extracción de frames desde: {gif_source_path}")
    extract_frames(gif_source_path, output_folder_path)