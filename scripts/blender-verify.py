"""Import an OpenSix FBX or GLB in Blender and report what an independent reader sees.

Usage:
  blender -b --python scripts/blender-verify.py -- <model.fbx|model.glb> <report.json> [render-prefix]

The script never touches the game folder. It reads the export, writes a JSON report and optional PNG renders.
"""
import json
import math
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
source, report_path = argv[0], argv[1]
render_prefix = argv[2] if len(argv) > 2 else None

bpy.ops.wm.read_factory_settings(use_empty=True)
if source.lower().endswith('.fbx'):
    bpy.ops.import_scene.fbx(filepath=source)
else:
    bpy.ops.import_scene.gltf(filepath=source)

meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
armatures = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
report = {'file': source, 'meshObjects': len(meshes), 'armatures': [], 'meshes': [], 'images': []}
low = Vector((1e9, 1e9, 1e9))
high = Vector((-1e9, -1e9, -1e9))
for obj in meshes:
    mesh = obj.data
    mesh.calc_loop_triangles()
    for corner in obj.bound_box:
        world = obj.matrix_world @ Vector(corner)
        low = Vector((min(low[i], world[i]) for i in range(3)))
        high = Vector((max(high[i], world[i]) for i in range(3)))
    textured = []
    for slot in obj.material_slots:
        material = slot.material
        if not material or not material.use_nodes:
            continue
        for node in material.node_tree.nodes:
            if node.type == 'TEX_IMAGE' and node.image:
                linked = [link.to_socket.name for output in node.outputs for link in output.links]
                textured.append({'material': material.name, 'image': node.image.name, 'size': list(node.image.size), 'linkedTo': linked})
    weighted = sum(1 for v in mesh.vertices if len(v.groups) > 0)
    report['meshes'].append({
        'name': obj.name, 'vertices': len(mesh.vertices), 'triangles': len(mesh.loop_triangles),
        'uvLayers': [layer.name for layer in mesh.uv_layers], 'materials': [s.material.name for s in obj.material_slots if s.material],
        'textures': textured, 'vertexGroups': len(obj.vertex_groups), 'weightedVertices': weighted,
        'normals': bool(mesh.has_custom_normals) or True,
    })
for arm in armatures:
    report['armatures'].append({'name': arm.name, 'bones': len(arm.data.bones)})
report['images'] = sorted({(i.name, i.size[0], i.size[1]) for i in bpy.data.images if i.name != 'Render Result'})
report['triangles'] = sum(m['triangles'] for m in report['meshes'])
report['dimensions'] = [round(high[i] - low[i], 4) for i in range(3)] if meshes else None
report['texturedMeshes'] = sum(1 for m in report['meshes'] if m['textures'])

if render_prefix and meshes:
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.render.resolution_x = 700
    scene.render.resolution_y = 900
    shading = scene.display.shading
    shading.light = 'STUDIO'
    shading.color_type = 'TEXTURE'
    scene.render.film_transparent = False
    world = bpy.data.worlds.new('w')
    world.color = (0.12, 0.1, 0.18)
    scene.world = world
    center = (low + high) / 2
    size = max(high - low)
    camera_data = bpy.data.cameras.new('cam')
    camera_data.lens = 70
    camera = bpy.data.objects.new('cam', camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    # Heights differ between Y-up glTF imports and Z-up FBX imports, so frame the longest axis.
    up = 2 if (high[2] - low[2]) >= (high[1] - low[1]) else 1
    for name, angle in (('front', 0), ('quarter', 40), ('side', 90)):
        radius = size * 2.6
        a = math.radians(angle)
        if up == 2:
            position = center + Vector((math.sin(a) * radius, -math.cos(a) * radius, 0))
        else:
            position = center + Vector((math.sin(a) * radius, 0, math.cos(a) * radius))
        camera.location = position
        direction = center - position
        camera.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = f'{render_prefix}-{name}.png'
        bpy.ops.render.render(write_still=True)
    report['renders'] = [f'{render_prefix}-{n}.png' for n in ('front', 'quarter', 'side')]

with open(report_path, 'w') as handle:
    json.dump(report, handle, indent=1)
print('REPORT', json.dumps({k: report[k] for k in ('meshObjects', 'triangles', 'texturedMeshes', 'dimensions')}))
