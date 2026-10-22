

def _start_baas_docs_local_measurement():
    import os
    from pathlib import Path
    import runpy
    import threading

    directory = Path(os.environ["BAAS_ANDROID_INTERNAL_FILES_DIR"]) / ".baas-docs-local-measure"
    if not (directory / "request.json").is_file():
        return
    threading.Thread(
        target=runpy.run_path,
        args=(str(directory / "worker.py"),),
        kwargs={"run_name": "__main__"},
        name="baas-docs-local-measure",
        daemon=True,
    ).start()


_start_baas_docs_local_measurement()
