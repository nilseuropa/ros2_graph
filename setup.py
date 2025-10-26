from setuptools import find_packages, setup

package_name = 'ros2_graph'

setup(
    name=package_name,
    version='0.0.0',
    packages=find_packages(exclude=['test']),
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
            'ros2_graph = ros2_graph.ros2_graph_node:main',
        ],
    },
)
