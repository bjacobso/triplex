import { DurableObject } from "cloudflare:workers";

export class TriplexTestObject extends DurableObject {
  override fetch(): Response {
    return new Response("Triplex conformance harness", { status: 404 });
  }
}

export default {
  fetch(): Response {
    return new Response("Triplex conformance harness");
  },
};
