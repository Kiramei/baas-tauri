export class Vector {
  constructor(public elements: number[]) {}

  static create(elements: number[]): Vector {
    return new Vector([...elements]);
  }

  flatten(): number[] {
    return this.elements;
  }
}

export class Matrix {
  constructor(public elements: number[][]) {}

  static create(elements: number[][]): Matrix {
    return new Matrix(elements.map((row) => [...row]));
  }

  static I(size: number): Matrix {
    const elements: number[][] = [];

    for (let i = 0; i < size; i++) {
      const row = new Array(size).fill(0);
      row[i] = 1;
      elements.push(row);
    }

    return new Matrix(elements);
  }

  static Translation(v: Vector): Matrix {
    if (v.elements.length === 2) {
      const r = Matrix.I(3);
      r.elements[2][0] = v.elements[0];
      r.elements[2][1] = v.elements[1];
      return r;
    }

    if (v.elements.length === 3) {
      const r = Matrix.I(4);
      r.elements[0][3] = v.elements[0];
      r.elements[1][3] = v.elements[1];
      r.elements[2][3] = v.elements[2];
      return r;
    }

    throw new Error("Invalid length for Translation");
  }

  x(other: Matrix): Matrix {
    const a = this.elements;
    const b = other.elements;

    const rows = a.length;
    const cols = b[0].length;
    const inner = b.length;

    const result: number[][] = [];

    for (let i = 0; i < rows; i++) {
      result[i] = [];

      for (let j = 0; j < cols; j++) {
        let sum = 0;

        for (let k = 0; k < inner; k++) {
          sum += a[i][k] * b[k][j];
        }

        result[i][j] = sum;
      }
    }

    return new Matrix(result);
  }

  flatten(): number[] {
    const result: number[] = [];

    if (this.elements.length === 0) {
      return result;
    }

    for (let j = 0; j < this.elements[0].length; j++) {
      for (let i = 0; i < this.elements.length; i++) {
        result.push(this.elements[i][j]);
      }
    }

    return result;
  }

  ensure4x4(): Matrix {
    if (this.elements.length === 4 && this.elements[0].length === 4) {
      return this;
    }

    if (this.elements.length > 4 || this.elements[0].length > 4) {
      throw new Error("Matrix cannot be converted to 4x4");
    }

    for (let i = 0; i < this.elements.length; i++) {
      for (let j = this.elements[i].length; j < 4; j++) {
        this.elements[i].push(i === j ? 1 : 0);
      }
    }

    for (let i = this.elements.length; i < 4; i++) {
      if (i === 0) {
        this.elements.push([1, 0, 0, 0]);
      } else if (i === 1) {
        this.elements.push([0, 1, 0, 0]);
      } else if (i === 2) {
        this.elements.push([0, 0, 1, 0]);
      } else {
        this.elements.push([0, 0, 0, 1]);
      }
    }

    return this;
  }
}
