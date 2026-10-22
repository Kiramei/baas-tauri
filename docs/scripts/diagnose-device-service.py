from adbutils import adb, Network
import argparse
import http.client
import json

parser = argparse.ArgumentParser()
parser.add_argument("serial")
parser.add_argument("package")
args = parser.parse_args()
device = adb.device(args.serial)
if device.app_current().package != args.package:
    raise RuntimeError("Expected the owned demo application in the foreground")


def request(path):
    connection = http.client.HTTPConnection("localhost", 7912, timeout=10)
    connection.sock = device.create_connection(Network.TCP, 7912)
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        payload = response.read()
        return response.status, response.getheader("Content-Type"), payload
    finally:
        connection.close()


status, _, version = request("/version")
image_status, content_type, image = request("/screenshot/0")
print(json.dumps({"transport": "ADB direct TCP to device loopback service; no host HTTP proxy",
                  "devicePort": 7912, "versionStatus": status,
                  "baasBridgeVersionConfirmed": version == b"baas-shizuku-display-1",
                  "screenshotStatus": image_status, "screenshotContentType": content_type,
                  "screenshotBytes": len(image),
                  "isPng": image.startswith(b"\x89PNG"), "isJpeg": image.startswith(b"\xff\xd8"),
                  "credentialsReadOrSent": False}))
