> The library is modified from https://github.com/NetrisTV/ws-scrcpy/tree/master/vendor/Broadway. Thanks the authors for their efforts.

This package is designed for Broadway Player which adopts the Canvas-based decoding method. The original library is constructed in JavaScript. And I converted it into TypeScript version for more readability.

For the initialization, we require inputing the `avc.wasm` path as the original team provided. Other parameters can be referred in `DecoderOptions` .

```typescript
const avc = new Decoder({
  wasmUrl: `${baseUrl}wasms/avc.wasm`,
  rgb: false,
});
```

And for the decoding stage, it is also easy to understand by using a callback function.

```typescript
avc.onPictureDecoded = (buffer: Uint8Array, decodedWidth: number, decodedHeight: number): void => {
  // Here you can process `decodedWidth, decodedHeight, buffer`.
};
```
