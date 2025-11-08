from pathlib import Path

from setuptools import find_packages, setup

package_name = 'ros2graph_explorer'


def collect_static_files():
    base_dir = Path(__file__).parent
    static_root = base_dir / package_name / 'web' / 'static'
    return [
        str(path.relative_to(base_dir / package_name))
        for path in static_root.rglob('*')
        if path.is_file()
    ]


setup(
    name=package_name,
    version='0.0.0',
    packages=find_packages(exclude=['test']),
    package_data={package_name: collect_static_files()},
    data_files=[
        ('share/ament_index/resource_index/packages',
            ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml', 'LICENSE']),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='nils',
    maintainer_email='marton@nowtech.hu',
    description='Headless ROS 2 computation graph visualizer inspired by rqt_graph.',
    license='BSD-3-Clause',
    extras_require={
        'test': [
            'pytest',
        ],
    },
    entry_points={
        'console_scripts': [
            'ros2graph_explorer = ros2graph_explorer.ros2_graph_node:main',
        ],
    },
)
