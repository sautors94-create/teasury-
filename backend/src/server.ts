import { crearApp } from "./app.js";
import { PUERTO } from "./config.js";
import { abrirBase } from "./db.js";

const db = abrirBase();
const app = crearApp(db);

app.listen(PUERTO, () => {
  console.log(`API de Tesorería escuchando en http://localhost:${PUERTO}`);
  console.log(`Base de datos: ${process.env.DB_PATH ?? "data/tesoreria.db"}`);
});