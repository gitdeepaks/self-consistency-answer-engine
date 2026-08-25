/**
 * Exhaustiveness guard for discriminated unions.
 *
 * Placed in the `default` branch of a switch over a union, this turns "somebody
 * added a variant and forgot a site" from a runtime surprise into a compile
 * error at every site that must handle it — which is the whole reason the
 * `RunEvent` union is a union rather than a bag of strings.
 *
 * The runtime throw is the belt to the compiler's braces: it only fires if a
 * value reached the branch that the type system said was unreachable, which
 * means something crossed a boundary without being parsed.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unhandled variant ${JSON.stringify(value)}`)
}
