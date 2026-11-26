import pkg from "../package.json" with { type: "json" };

/** Versión del paquete, tomada de package.json en tiempo de build. */
export const VERSION: string = pkg.version;
