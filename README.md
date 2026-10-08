# OFSC FRONT V22.21 — UI compacta + Excel enriquecido

Cambios:
- Paginado movido al pie de la tabla.
- Filtros e iconos en una sola línea en pantallas amplias; iconos SVG.
- KPI más compactos y con tipografía de valor mayor; una fila cuando hay ancho suficiente.
- “Completados: Ayer / Hoy” integrado al encabezado/cuerpo superior de la tabla y desplegable desde allí.
- Exportación Excel general incluye hojas `Tareas` y `Resumen KPI` con los KPI del frente y estados Ayer/Hoy.
- ZIP por contratista mantiene un XLSX por contratista y agrega en `Resumen KPI` una imagen embebida tipo captura del tablero de ese contratista (KPI + estados + vista previa de tareas), además de los datos KPI en celdas.
- No requiere cambios en Worker ni Apps Script respecto de V22.20.

Para actualizar el frontend, reemplazar: `index.html`, `app.js`, `styles.css`, `config.js`.

Nota: la captura embebida usa ExcelJS + html2canvas cargados por CDN. Si esas librerías no están disponibles, el exportador conserva un fallback sin imagen embebida.
