import importlib.util
from pathlib import Path
import unittest

from PIL import Image, ImageChops


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("android_game_media", ROOT / "docs/scripts/publish-android-game-media.py")
MEDIA = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MEDIA)


class AndroidGameMediaTest(unittest.TestCase):
    def test_gaussian_blur_changes_only_the_reviewed_account_region(self):
        source = Image.new("RGBA", MEDIA.SIZE, (210, 240, 255, 255))
        for y in range(MEDIA.ACCOUNT_BOX[1], MEDIA.ACCOUNT_BOX[3]):
            for x in range(MEDIA.ACCOUNT_BOX[0], MEDIA.ACCOUNT_BOX[2]):
                source.putpixel((x, y), ((x * 31 + y * 7) % 256, (x * 3) % 256, (y * 11) % 256, 255))
        result = MEDIA.blur_account(source)
        self.assertEqual(source.size, result.size)
        self.assertEqual(source.mode, result.mode)
        changed = False
        for before, after in zip(source.split(), result.split()):
            bounds = ImageChops.difference(before, after).getbbox()
            if bounds is not None:
                changed = True
                self.assertGreaterEqual(bounds[0], MEDIA.ACCOUNT_BOX[0])
                self.assertGreaterEqual(bounds[1], MEDIA.ACCOUNT_BOX[1])
                self.assertLessEqual(bounds[2], MEDIA.ACCOUNT_BOX[2])
                self.assertLessEqual(bounds[3], MEDIA.ACCOUNT_BOX[3])
        self.assertTrue(changed)

    def test_different_geometry_and_empty_blur_fail_before_publication(self):
        with self.assertRaisesRegex(ValueError, "dimensions"):
            MEDIA.blur_account(Image.new("RGB", (1280, 720)))
        with self.assertRaisesRegex(ValueError, "changed no pixels"):
            MEDIA.blur_account(Image.new("RGB", MEDIA.SIZE, "white"))


if __name__ == "__main__":
    unittest.main()
