import { settings } from "./settings";
import { add } from "./mathx";

export class Client {
  start(): void {
    const port = add(settings.port, 1);
    console.log("starting on", port);
    fetch("http://localhost");
  }
}
