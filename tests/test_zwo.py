"""zwo.py must agree with public/zwo.js. Run: python3 -m unittest discover tests"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import strava  # noqa: E402
import zwo  # noqa: E402

PRESETS = sorted(glob.glob(os.path.join(ROOT, "presets", "*", "*.zwo")))


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


class MatchesTheApp(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_every_preset(self):
        workouts = [zwo.parse(read(p)) for p in PRESETS]
        run = subprocess.run(
            ["node", os.path.join(ROOT, "tests", "zwo_js.mjs")],
            input=json.dumps(workouts), capture_output=True, text=True, check=True,
        )
        for path, w, js in zip(PRESETS, workouts, json.loads(run.stdout)):
            name = os.path.relpath(path, ROOT)
            with self.subTest(name):
                self.assertEqual(zwo.serialize(w), js["xml"])
                s = zwo.stats(w)
                self.assertEqual(s["duration"], js["duration"])
                self.assertAlmostEqual(s["IF"], js["IF"], places=9)
                self.assertAlmostEqual(s["tss"], js["tss"], places=6)
                self.assertEqual(zwo.categorize(w), js["category"])

    def test_round_trip(self):
        for path in PRESETS:
            with self.subTest(os.path.relpath(path, ROOT)):
                w = zwo.parse(read(path))
                self.assertEqual(zwo.parse(zwo.serialize(w)), w)

    def test_agent_dialect_round_trip(self):
        for path in PRESETS:
            with self.subTest(os.path.relpath(path, ROOT)):
                w = zwo.parse(read(path))
                if w["category"] and w["category"] not in zwo.CATEGORIES:
                    w["category"] = ""
                back = zwo.from_agent(zwo.to_agent(w), w["author"])
                self.assertEqual(zwo.serialize(back), zwo.serialize({**w, "name": w["name"].strip()}))


class ChecksAgentInput(unittest.TestCase):
    def ok(self, **extra):
        return {"name": "Test", "blocks": [{"type": "steady", "duration": 600, "power": 70}], **extra}

    def bad(self, data, words):
        with self.assertRaises(zwo.WorkoutError) as e:
            zwo.from_agent(data, "Claude")
        self.assertIn(words, str(e.exception))

    def test_accepts_a_simple_workout(self):
        w = zwo.from_agent(self.ok(), "Claude")
        self.assertEqual(w["blocks"][0]["power"], 0.7)
        self.assertIn('Power="0.7"', zwo.serialize(w))

    def test_rejects(self):
        self.bad({"blocks": []}, "name is required")
        self.bad(self.ok(blocks=[]), "non-empty")
        self.bad(self.ok(blocks=[{"type": "sprint", "duration": 10}]), "type must be one of")
        self.bad(self.ok(blocks=[{"type": "steady", "duration": 60, "power": 420}]), "outside 0-300")
        self.bad(self.ok(blocks=[{"type": "steady", "duration": 60.5, "power": 70}]), "whole number")
        self.bad(self.ok(blocks=[{"type": "steady", "duration": 60, "power": 70, "watts": 200}]), "unknown field")
        self.bad(self.ok(blocks=[{"type": "steady", "duration": 21600, "power": 50}] * 2), "limit is 6 hours")
        self.bad(self.ok(category="Hard"), "category must be one of")
        self.bad(
            self.ok(blocks=[{"type": "steady", "duration": 60, "power": 70, "text_events": [{"offset": 60, "message": "x"}]}]),
            "outside 0-59",
        )

    def test_escapes_text(self):
        w = zwo.from_agent(self.ok(name='<b>"Hi"</b> & bye'), "Claude")
        xml = zwo.serialize(w)
        self.assertIn("&lt;b&gt;&quot;Hi&quot;&lt;/b&gt; &amp; bye", xml)
        self.assertEqual(zwo.parse(xml)["name"], '<b>"Hi"</b> & bye')

    def test_refuses_entities(self):
        with self.assertRaises(zwo.WorkoutError):
            zwo.parse('<!DOCTYPE x [<!ENTITY a "aaaa">]><workout_file><workout/></workout_file>')


def steady(minutes, power):
    return {"type": "steady", "duration": minutes * 60, "power": power}


class TextChart(unittest.TestCase):
    def test_draws_bars_in_zone_colours(self):
        w = {"blocks": [steady(10, 0.5), steady(10, 1.0), steady(10, 0.5)]}
        blank = zwo.BLANK
        self.assertEqual(zwo.text_chart(w, cols=3, rows=2), f"{blank}🟨{blank}\n⬜🟨⬜")

    def test_every_preset_is_a_full_grid(self):
        cells = set(zwo.ZONE_SQUARES) | {zwo.BLANK}
        for path in PRESETS:
            lines = zwo.text_chart(zwo.parse(read(path))).split("\n")
            self.assertEqual(len(lines), 5, path)
            for line in lines:
                self.assertEqual(len(line), 15, path)
                self.assertLessEqual(set(line), cells, path)

    def test_rests_between_efforts_show(self):
        w = zwo.parse(read(os.path.join(ROOT, "presets", "originals", "threshold-build-3x15.zwo")))
        bottom = zwo.text_chart(w).split("\n")[-1]
        self.assertEqual(re.findall("🟨+⬜(?=🟨)", bottom), ["🟨🟨🟨⬜", "🟨🟨⬜"])  # both 5-min rests

    def test_empty_workout(self):
        self.assertEqual(zwo.text_chart({"blocks": []}), "")

    def test_zones_match_the_app(self):
        js = read(os.path.join(ROOT, "public", "zwo.js"))
        tops = [float(x) for x in re.findall(r"\{ max: ([\d.]+), name: \"Z\d\"", js)]
        self.assertEqual(tops, list(zwo.ZONE_TOPS[:-1]))


class StravaDescription(unittest.TestCase):
    ride = {"ftp": 285, "summary": {"np": 251, "if": 0.88, "tss": 92}}

    def test_chart_comes_first(self):
        w = {"blocks": [steady(10, 0.5), steady(10, 1.0)]}
        text = strava.describe(self.ride, w)
        self.assertEqual(text.split("\n\n"), [zwo.text_chart(w), "NP 251 W · IF 0.88 · TSS 92 · FTP 285 W", "Ridden on Whorl"])

    def test_without_a_workout(self):
        self.assertEqual(strava.describe(self.ride), "NP 251 W · IF 0.88 · TSS 92 · FTP 285 W\n\nRidden on Whorl")


if __name__ == "__main__":
    unittest.main()
