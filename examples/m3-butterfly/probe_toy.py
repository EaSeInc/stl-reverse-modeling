
import os, sys, tempfile, shutil, numpy as np
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import fit_params as F
import trimesh

TPL = os.path.join(ROOT, "templates", "soma_part_example.py")
d = tempfile.mkdtemp(prefix='toy_')
m = os.path.join(d, 'model.py'); shutil.copyfile(TPL, m)
TRUTH = dict(W=32.0, D=22.0, T=4.6, BOSS_D=9.2)
F.write_params(m, TRUTH)
ref = os.path.join(d, 'ref.stl'); F.build_stl(m, ref)
print('ref', trimesh.load_mesh(ref, force='mesh').volume, flush=True)

names = ['W', 'D', 'T', 'BOSS_D']
fit = F.Fit(m, ref, names, samples=2200)
fit.realign = True
zero = np.array([TRUTH[k] for k in names])

def probe(x, tag):
    r = fit._eval(np.asarray(x, float), tag=tag)
    M = fit.align_M
    ang = np.degrees(np.arccos(np.clip((np.trace(M[:3,:3]) - 1) / 2, -1, 1)))
    t = np.linalg.norm(M[:3, 3])
    # где живёт остаток: доля точек дальше 0.1 мм и их средняя координата
    q_m, _ = trimesh.sample.sample_surface(fit.current, 4000, seed=5)
    _, d_mr, _ = trimesh.proximity.closest_point(fit.ref_aligned, q_m)
    bad = q_m[d_mr > 0.1]
    print('%-22s rms %.4f  p95 %.3f  max %.3f  поворот %.2f°  |t| %.3f  точек>0.1: %d (центр %s)' % (
        tag, np.sqrt(np.mean(r**2)), np.percentile(r,95), r.max(), ang, t, len(bad),
        np.round(bad.mean(axis=0),2).tolist() if len(bad) else '-'), flush=True)
    return np.sqrt(np.mean(r**2))

probe(zero, 'истина')
probe([32.204, 22.181, 4.599, 9.171], 'фит')
probe([32.0, 22.2, 4.6, 9.2], 'только D=22.2')
probe([32.2, 22.0, 4.6, 9.2], 'только W=32.2')
probe([31.8, 21.8, 4.6, 9.2], 'W/D минус 0.2')
