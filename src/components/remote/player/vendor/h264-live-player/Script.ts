export default class Script {
  constructor(
    public type: string,
    public source: string
  ) {}

  public static createFromSource(type: string, source: string): Script {
    return new Script(type, source);
  }
}
