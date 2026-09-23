from setuptools import setup, find_packages
from pathlib import Path

long_description = (Path(__file__).parent.parent / "README.md").read_text("utf-8")

setup(
    name="strip",
    version="0.3.1",
    description="Webtoon downloader and library manager",
    long_description=long_description,
    long_description_content_type="text/markdown",
    author="strip contributors",
    python_requires=">=3.9",
    packages=find_packages(),
    install_requires=[
        "requests>=2.31.0",
        "beautifulsoup4>=4.12.0",
        "lxml>=5.0.0",
        "Pillow>=10.0.0",
        "rich>=13.0.0",
        "click>=8.1.0",
    ],
    entry_points={
        "console_scripts": [
            "stripdl=strip.cli:main",
        ],
    },
)
