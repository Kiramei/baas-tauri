import { Matrix } from "./Matrix";

//
// gluPerspective
//
export function makePerspective(fovy: number, aspect: number, znear: number, zfar: number): Matrix {
  const ymax = znear * Math.tan((fovy * Math.PI) / 360.0);
  const ymin = -ymax;
  const xmin = ymin * aspect;
  const xmax = ymax * aspect;

  return makeFrustum(xmin, xmax, ymin, ymax, znear, zfar);
}

//
// glFrustum
//
function makeFrustum(
  left: number,
  right: number,
  bottom: number,
  top: number,
  znear: number,
  zfar: number
): Matrix {
  const X = (2 * znear) / (right - left);
  const Y = (2 * znear) / (top - bottom);
  const A = (right + left) / (right - left);
  const B = (top + bottom) / (top - bottom);
  const C = -(zfar + znear) / (zfar - znear);
  const D = (-2 * zfar * znear) / (zfar - znear);

  return Matrix.create([
    [X, 0, A, 0],
    [0, Y, B, 0],
    [0, 0, C, D],
    [0, 0, -1, 0],
  ]);
}
