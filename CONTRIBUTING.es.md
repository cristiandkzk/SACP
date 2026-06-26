# Contribuir a Safe Automation Control Plane (SACP)

[English](CONTRIBUTING.md) · [Español](CONTRIBUTING.es.md)

Esto es un patrón, no un framework, así que las contribuciones más valiosas son
**reportes de experiencia**, no pedidos de features.

Especialmente bienvenidos:

- Un bug que encontraste implementando el patrón, con el fix y la regla que te
  dejó (el formato de [docs/lessons-learned.md](docs/lessons-learned.md)).
- Una implementación de referencia en un lenguaje o stack que todavía no esté
  cubierto. Linkealo; no tiene que vivir en este repo.
- Un nuevo `action.type`, adapter de canal o forma de manifest de proveedor que
  el core no haya anticipado.
- Correcciones donde el spec no coincida con lo que la producción realmente
  requiere.

Por favor mantené los docs **agnósticos al stack**. Los ejemplos concretos son
buenos; las dependencias duras a una base de datos, framework o proveedor
específico no — empujá eso a una sección claramente etiquetada como "ejemplo".

Abrí un issue para discutir cualquier cosa grande antes de escribirla.
