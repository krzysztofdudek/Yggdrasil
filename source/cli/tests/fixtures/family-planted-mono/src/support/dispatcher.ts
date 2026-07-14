export class Dispatcher {
  dispatch(kind: string): number {
    switch (kind) {
      case "create":
        return 1;
      case "update":
        return 2;
      case "delete":
        return 3;
      default:
        return 0;
    }
  }
}
